using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Сохранение выгрузок WMS (браузер забрал данные — сюда записать): комплектация,
// размещение, приёмка, остатки, спуск и пополнение (stock-moves). Перенесено
// из Node 2026-10-31 (раньше Node принимал тело и пересылал сюда кусками на
// внутренние /ingest). Браузер присылает период одним запросом — лимит тела
// поднят до 300 МБ только для этих путей; запись в базу идёт кусками.
// В ответе newEmployees — исполнители, которых нет в списке сотрудников по ID.
public static class WmsSaveEndpoints
{
    private const long MaxBodyBytes = 300L * 1024 * 1024;
    private const int ChunkSize = 10000;

    private static async Task<List<JsonElement>> ReadItemsAsync(HttpContext ctx)
    {
        var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = MaxBodyBytes;
        // документ не освобождаем: элементы ссылаются на его буфер, копия (Clone)
        // удвоила бы память на выгрузке в сотни МБ; буфер соберёт GC
        var doc = await JsonDocument.ParseAsync(ctx.Request.Body);
        var root = doc.RootElement;
        // { value: { items } } (postOwnBackend в wmsFetch.js) или плоский { items }
        JsonElement items = default;
        var found = root.ValueKind == JsonValueKind.Object
            && ((root.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.Object && v.TryGetProperty("items", out items))
                || root.TryGetProperty("items", out items))
            && items.ValueKind == JsonValueKind.Array;
        return found ? items.EnumerateArray().ToList() : new();
    }

    private static async Task<(int Added, int Skipped)> InChunks(List<JsonElement> items, Func<List<JsonElement>, Task<(int, int)>> save)
    {
        int added = 0, skipped = 0;
        for (var i = 0; i < items.Count; i += ChunkSize)
        {
            var (a, s) = await save(items.GetRange(i, Math.Min(ChunkSize, items.Count - i)));
            added += a; skipped += s;
        }
        return (added, skipped);
    }

    public static void MapWmsSaveEndpoints(this WebApplication app)
    {
        // комплектация и остальные операции; «Обновлено» = время последней выгрузки
        app.MapPost("/api/save-fetched-data", async (HttpContext ctx, StatsService svc, AppStateService state) =>
        {
            try
            {
                var t0 = DateTime.UtcNow;
                var items = await ReadItemsAsync(ctx);
                var newEmployees = await svc.FindNewEmployeesAsync(items);
                var (added, _) = await InChunks(items, async c => { var a = await svc.IngestOpsAsync(c); return (a, 0); });
                await state.SetAsync("last-run", new JsonObject { ["lastRun"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") });
                return Results.Json(new
                {
                    ok = true, engine = "postgres", added, skipped = Math.Max(0, items.Count - added), itemsCount = items.Count, newEmployees,
                    timings = new { totalMs = (int)(DateTime.UtcNow - t0).TotalMilliseconds },
                });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = "Не удалось сохранить в базу: " + err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        var ops = new (string Op, Func<StatsService, List<JsonElement>, Task<(int, int)>> Save)[]
        {
            ("placement", (s, c) => s.SavePlacementItemsAsync(c)),
            ("receiving", (s, c) => s.SaveReceivingItemsAsync(c)),
            ("remains", (s, c) => s.SaveRemainsItemsAsync(c)),
            // спуск и пополнение — одним запросом, сервис сам раскладывает по типам
            ("stock-moves", (s, c) => s.SaveStockMovesAsync(c)),
        };
        foreach (var (op, save) in ops)
        {
            app.MapPost($"/api/stats/{op}/save", async (HttpContext ctx, StatsService svc) =>
            {
                try
                {
                    var t0 = DateTime.UtcNow;
                    var items = await ReadItemsAsync(ctx);
                    var newEmployees = await svc.FindNewEmployeesAsync(items);
                    var (added, skipped) = await InChunks(items, c => save(svc, c));
                    return Results.Json(new
                    {
                        ok = true, operation = op, added, skipped, itemsCount = items.Count, newEmployees,
                        timings = new { totalMs = (int)(DateTime.UtcNow - t0).TotalMilliseconds },
                    });
                }
                catch (Exception err) { return Results.Json(new { ok = false, error = "Не удалось сохранить в базу: " + err.Message }, statusCode: 500); }
            }).AddEndpointFilter<VsSessionRequiredFilter>();
        }
    }
}
