using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Фото РК (приёмка, отгрузка): POST /api/rk/photos сохраняет фото и превью
// на диск сервера — том rk-photos (docker-compose.yml). Раздаёт их Caddy
// прямо с диска: /rk-photos/<имя> и /rk-photos/thumb/<имя> — dotnet в этом
// не участвует. Раньше фото уходили во внешнее S3-хранилище (2026-10-31 убрано).
// Браузер присылает уже сжатые фото (lib/compressImage.js), здесь —
// нормализация (поворот по EXIF, JPEG) и превью.
public static class PhotoEndpoints
{
    private const long MaxFileSize = 5 * 1024 * 1024; // фото приходят сжатыми браузером

    public static void MapPhotoEndpoints(this WebApplication app)
    {
        var photoDir = Environment.GetEnvironmentVariable("RK_PHOTOS_DIR") ?? "/data/rk-photos";
        var thumbDir = Path.Combine(photoDir, "thumb");
        Directory.CreateDirectory(thumbDir);

        app.MapPost("/api/rk/photos", async (HttpRequest request, PhotoService photos) =>
        {
            if (!request.HasFormContentType)
                return Results.BadRequest(new { ok = false, error = "Ожидается multipart/form-data" });

            var form = await request.ReadFormAsync();
            var files = form.Files.Where(f => f.Name == "photos" && (f.ContentType ?? "").StartsWith("image/")).ToList();
            if (files.Any(f => f.Length > MaxFileSize))
                return Results.BadRequest(new { ok = false, error = "Файл слишком большой (максимум 5 МБ)" });

            try
            {
                var urls = new List<string>();
                foreach (var f in files)
                {
                    using var ms = new MemoryStream();
                    await f.CopyToAsync(ms);
                    var name = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}".Substring(0, 24) + ".jpg";
                    var main = photos.CompressMain(ms.ToArray());
                    var thumb = photos.CompressThumb(main);
                    await File.WriteAllBytesAsync(Path.Combine(photoDir, name), main);
                    await File.WriteAllBytesAsync(Path.Combine(thumbDir, name), thumb);
                    urls.Add($"/rk-photos/{name}");
                }
                return Results.Json(new { ok = true, urls });
            }
            catch (Exception e)
            {
                return Results.Json(new { ok = false, error = e.Message }, statusCode: 500);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
