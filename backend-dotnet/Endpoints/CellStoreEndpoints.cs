using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// ЦФЗ по ячейкам КДК (CellStoreService). Чтение — всем вошедшим (нужно
// «Поиску потеряшек»), загрузка из WMS и удаление зоны — admin/developer.
public static class CellStoreEndpoints
{
    public record SyncCell(string? Address, string? StoreName);
    public record SyncRequest(string? ZoneId, string? ZoneName, List<SyncCell>? Cells);

    public static void MapCellStoreEndpoints(this WebApplication app)
    {
        app.MapGet("/api/cell-stores", async (CellStoreService svc) =>
        {
            try
            {
                var cells = await svc.ListAsync();
                var zones = cells.GroupBy(c => c.ZoneId).Select(g => new
                {
                    zoneId = g.Key,
                    zoneName = g.First().ZoneName,
                    cells = g.Count(),
                    stores = g.Where(c => c.StoreName != "").Select(c => c.StoreName).Distinct().Count(),
                    updatedAt = g.Max(c => c.UpdatedAt),
                }).OrderBy(z => z.zoneName).ToList();
                return Results.Json(new
                {
                    zones,
                    cells = cells.Select(c => new { address = c.Address, storeName = c.StoreName, zoneId = c.ZoneId }).ToList(),
                });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/cell-stores/sync", async (SyncRequest body, CellStoreService svc) =>
        {
            try
            {
                var zoneId = (body.ZoneId ?? "").Trim();
                if (zoneId == "") return Results.Json(new { error = "Нужен zoneId" }, statusCode: 400);
                var cells = (body.Cells ?? new())
                    .Where(c => !string.IsNullOrWhiteSpace(c.Address))
                    .Select(c => (c.Address!.Trim(), (c.StoreName ?? "").Trim()))
                    .ToList();
                var saved = await svc.ReplaceZoneAsync(zoneId, (body.ZoneName ?? "").Trim(), cells);
                return Results.Json(new { ok = true, saved });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapPost("/api/cell-stores/delete-zone", async (SyncRequest body, CellStoreService svc) =>
        {
            try { return Results.Json(new { ok = true, deleted = await svc.DeleteZoneAsync((body.ZoneId ?? "").Trim()) }); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();
    }
}
