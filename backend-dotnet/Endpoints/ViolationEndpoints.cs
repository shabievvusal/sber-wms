using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// «Нарушения» (перенесено из Node 2026-10-31): список — в app_state (ключ
// violations, тот же, что был у Node), видео — файлами в томе node-persist
// (VIOLATION_VIDEOS_DIR). Видео до 500 МБ — лимит запроса поднят только здесь.
public static class ViolationEndpoints
{
    private const long MaxVideoBytes = 500L * 1024 * 1024;

    public static void MapViolationEndpoints(this WebApplication app)
    {
        var videoDir = Environment.GetEnvironmentVariable("VIOLATION_VIDEOS_DIR") ?? "/data/node-persist/data/violation-videos";
        Directory.CreateDirectory(videoDir);

        static JsonArray AsList(JsonNode? n) => n as JsonArray ?? new JsonArray();

        app.MapGet("/api/violations", async (AppStateService state) =>
            Results.Json(AsList(await state.GetAsync("violations"))))
            .AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/violations", async (HttpContext ctx, AppStateService state) =>
        {
            var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = MaxVideoBytes + 1024 * 1024;
            if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { error = "Ожидается multipart/form-data" });

            var form = await ctx.Request.ReadFormAsync(new FormOptions { MultipartBodyLengthLimit = MaxVideoBytes + 1024 * 1024 });
            var title = form["title"].ToString().Trim();
            var video = form.Files.GetFile("video");
            if (title == "" || video == null) return Results.BadRequest(new { error = "Нужны название и видео" });
            if (!(video.ContentType ?? "").StartsWith("video/")) return Results.BadRequest(new { error = "Только видео-файлы" });
            if (video.Length > MaxVideoBytes) return Results.BadRequest(new { error = "Видео больше 500 МБ" });

            var ext = Path.GetExtension(video.FileName);
            if (string.IsNullOrEmpty(ext) || ext.Length > 6) ext = ".mp4";
            var fileName = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}"[..24] + ext.ToLowerInvariant();
            await using (var fs = File.Create(Path.Combine(videoDir, fileName)))
                await video.CopyToAsync(fs);

            double? damage = double.TryParse(form["damage"].ToString().Replace(',', '.'), System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : null;
            var item = new JsonObject
            {
                ["id"] = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}"[..24],
                ["title"] = title,
                ["damage"] = damage,
                ["videoFile"] = fileName,
                ["createdAt"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
            };
            var list = AsList(await state.GetAsync("violations"));
            list.Insert(0, item);
            await state.SetAsync("violations", list);
            return Results.Json(item);
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapDelete("/api/violations/{id}", async (string id, AppStateService state) =>
        {
            var list = AsList(await state.GetAsync("violations"));
            var item = list.FirstOrDefault(v => v?["id"]?.ToString() == id);
            if (item == null) return Results.NotFound(new { error = "Не найдено" });
            var file = Path.GetFileName(item["videoFile"]?.ToString() ?? "");
            list.Remove(item);
            await state.SetAsync("violations", list);
            if (file != "") { var p = Path.Combine(videoDir, file); if (File.Exists(p)) File.Delete(p); }
            return Results.Json(new { ok = true });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // видео с перемоткой (Range-запросы)
        app.MapGet("/violation-videos/{filename}", (string filename) =>
        {
            var path = Path.Combine(videoDir, Path.GetFileName(filename));
            if (!File.Exists(path)) return Results.NotFound(new { error = "Файл не найден" });
            var type = Path.GetExtension(path).ToLowerInvariant() switch
            {
                ".webm" => "video/webm", ".mov" => "video/quicktime", ".mkv" => "video/x-matroska", ".avi" => "video/x-msvideo", _ => "video/mp4",
            };
            return Results.File(path, type, enableRangeProcessing: true);
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
