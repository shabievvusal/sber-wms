using BackendDotnet.Services;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Processing;

namespace BackendDotnet.Endpoints;

// Порт POST /api/rk/photos (sharp -> S3, server.js) + раздачи /rk-photos/*.
// Локальный каталог здесь — практически всегда пуст (фото всегда льются в S3,
// как и в оригинале, где savePhoto()/локальный fallback — мёртвый код), но
// двухступенчатый путь «сначала локальный файл, потом редирект на S3»
// воспроизведён для полной параллели с оригиналом.
public static class PhotoEndpoints
{
    private const long MaxFileSize = 20 * 1024 * 1024; // 20 MB, как в multer-лимите оригинала

    public static void MapPhotoEndpoints(this WebApplication app)
    {
        var photoDir = Path.Combine(AppContext.BaseDirectory, "data", "rk-photos");
        var thumbDir = Path.Combine(photoDir, "thumbs");
        Directory.CreateDirectory(thumbDir);

        app.MapPost("/api/rk/photos", async (HttpRequest request, PhotoService photos, S3Service s3) =>
        {
            if (!request.HasFormContentType)
                return Results.BadRequest(new { ok = false, error = "Ожидается multipart/form-data" });

            var form = await request.ReadFormAsync();
            var files = form.Files.Where(f => f.Name == "photos" && (f.ContentType ?? "").StartsWith("image/")).ToList();

            foreach (var f in files)
            {
                if (f.Length > MaxFileSize)
                    return Results.BadRequest(new { ok = false, error = "Файл слишком большой (максимум 20 МБ)" });
            }

            try
            {
                var urls = new List<string>();
                foreach (var f in files)
                {
                    using var ms = new MemoryStream();
                    await f.CopyToAsync(ms);
                    var original = ms.ToArray();
                    var name = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}".Substring(0, 24) + ".jpg";
                    var compressed = photos.CompressMain(original);
                    var thumb = photos.CompressThumb(compressed);
                    await Task.WhenAll(
                        s3.UploadFileAsync($"rk-photos/{name}", compressed),
                        s3.UploadFileAsync($"rk-photos/thumbs/{name}", thumb));
                    urls.Add($"/rk-photos/{name}");
                }
                return Results.Json(new { ok = true, urls });
            }
            catch (Exception e)
            {
                return Results.Json(new { ok = false, error = e.Message }, statusCode: 500);
            }
        });

        // GET /rk-photos/thumb/:filename — генерит и кэширует превью на диск при первом обращении
        app.MapGet("/rk-photos/thumb/{filename}", async (string filename, S3Service s3) =>
        {
            var safeName = Path.GetFileName(filename);
            var origPath = Path.Combine(photoDir, safeName);
            var thumbName = System.Text.RegularExpressions.Regex.Replace(safeName, @"\.[^.]+$", ".jpg");
            var thumbPath = Path.Combine(thumbDir, thumbName);

            if (!origPath.StartsWith(photoDir)) return Results.StatusCode(403);

            try
            {
                if (File.Exists(origPath))
                {
                    if (!File.Exists(thumbPath))
                    {
                        using var image = Image.Load(origPath);
                        image.Mutate(x => x.Resize(new ResizeOptions { Size = new Size(144, 144), Mode = ResizeMode.Crop }));
                        await image.SaveAsync(thumbPath, new JpegEncoder { Quality = 70 });
                    }
                    return Results.File(thumbPath, "image/jpeg");
                }
                return Results.Redirect(s3.PublicUrl($"rk-photos/thumbs/{thumbName}"), permanent: true);
            }
            catch
            {
                return Results.NotFound();
            }
        });

        // GET /rk-photos/:filename — оригинал (локальный файл, иначе редирект на S3)
        app.MapGet("/rk-photos/{filename}", (string filename, S3Service s3) =>
        {
            var safeName = Path.GetFileName(filename);
            var filePath = Path.Combine(photoDir, safeName);
            if (!filePath.StartsWith(photoDir)) return Results.StatusCode(403);
            if (File.Exists(filePath)) return Results.File(filePath, "image/jpeg");
            return Results.Redirect(s3.PublicUrl($"rk-photos/{safeName}"), permanent: true);
        });
    }
}
