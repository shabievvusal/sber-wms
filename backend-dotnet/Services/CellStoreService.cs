using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;

namespace BackendDotnet.Services;

// ЦФЗ по ячейкам КДК: какой магазин (storeName из WMS topology/v2/cells/find)
// закреплён за ячейкой. Загружается из WMS браузером по зонам (Настройки),
// используется в «Поиске потеряшек» — куда должна уехать найденная ЕО.
// Таблица cell_stores, по складам; сырым SQL — справочник маленький и
// простой, отдельная EF-сущность ему не нужна.
public class CellStoreService
{
    private readonly AppDbContext _db;
    public CellStoreService(AppDbContext db) { _db = db; }

    public class CellStore
    {
        public string Address { get; set; } = "";
        public string CellId { get; set; } = "";
        public string StoreName { get; set; } = "";
        public string ZoneId { get; set; } = "";
        public string ZoneName { get; set; } = "";
        public DateTime UpdatedAt { get; set; }
    }

    public async Task<List<CellStore>> ListAsync()
    {
        var wh = _db.WarehouseId;
        return await _db.Database
            .SqlQuery<CellStore>($"SELECT address AS \"Address\", cell_id AS \"CellId\", store_name AS \"StoreName\", zone_id AS \"ZoneId\", zone_name AS \"ZoneName\", updated_at AS \"UpdatedAt\" FROM cell_stores WHERE warehouse_id = {wh} ORDER BY address")
            .ToListAsync();
    }

    // Заменить ячейки зоны целиком — то, что пришло из WMS сейчас.
    public async Task<int> ReplaceZoneAsync(string zoneId, string zoneName, List<(string Address, string CellId, string StoreName)> cells)
    {
        var wh = _db.WarehouseId;
        await using var tx = await _db.Database.BeginTransactionAsync();
        await _db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM cell_stores WHERE warehouse_id = {wh} AND zone_id = {zoneId}");
        // одним запросом через unnest — в зоне ЗГЗ тысячи ячеек
        var addresses = cells.Select(c => c.Address).ToArray();
        var cellIds = cells.Select(c => c.CellId).ToArray();
        var stores = cells.Select(c => c.StoreName).ToArray();
        await _db.Database.ExecuteSqlInterpolatedAsync($@"
            INSERT INTO cell_stores (warehouse_id, address, cell_id, store_name, zone_id, zone_name, updated_at)
            SELECT {wh}, a, i, s, {zoneId}, {zoneName}, now() FROM unnest({addresses}::text[], {cellIds}::text[], {stores}::text[]) AS t(a, i, s)
            ON CONFLICT (warehouse_id, address) DO UPDATE SET cell_id = EXCLUDED.cell_id, store_name = EXCLUDED.store_name, zone_id = EXCLUDED.zone_id, zone_name = EXCLUDED.zone_name, updated_at = now()");
        await tx.CommitAsync();
        return cells.Count;
    }

    public async Task<int> DeleteZoneAsync(string zoneId)
    {
        var wh = _db.WarehouseId;
        return await _db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM cell_stores WHERE warehouse_id = {wh} AND zone_id = {zoneId}");
    }
}
