using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using BackendDotnet.Data;

namespace BackendDotnet.Services;

// Небольшие данные склада «ключ → JSON» (таблица app_state): перекличка,
// настройки автообновления, «Обновлено», нарушения. Таблица общая с Node
// (backend/state-pg.js), пока часть разделов ещё там.
public class AppStateService
{
    private readonly AppDbContext _db;
    public AppStateService(AppDbContext db) { _db = db; }

    public async Task<JsonNode?> GetAsync(string key)
    {
        var rows = await _db.Database.SqlQueryRaw<string>(
            "SELECT value::text AS \"Value\" FROM app_state WHERE warehouse_id = @wh AND key = @k",
            new NpgsqlParameter("wh", _db.WarehouseId), new NpgsqlParameter("k", key)).ToListAsync();
        return rows.Count > 0 ? JsonNode.Parse(rows[0]) : null;
    }

    public async Task SetAsync(string key, JsonNode value)
    {
        await _db.Database.ExecuteSqlRawAsync(@"
            INSERT INTO app_state (warehouse_id, key, value, updated_at) VALUES (@wh, @k, @v, now())
            ON CONFLICT (warehouse_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            new NpgsqlParameter("wh", _db.WarehouseId), new NpgsqlParameter("k", key),
            new NpgsqlParameter("v", NpgsqlDbType.Jsonb) { Value = value.ToJsonString() });
    }
}

// «Запрошено обновление данных» (кнопка у тех, у кого нет токена WMS; устройство
// с автообновлением видит флаг и обновляет). По складу, в памяти — как и раньше в Node.
public class FetchRequestService
{
    private readonly ConcurrentDictionary<string, bool> _requested = new();
    public void Request(string warehouseId) => _requested[warehouseId] = true;
    public void Clear(string warehouseId) => _requested.TryRemove(warehouseId, out _);
    public bool IsRequested(string warehouseId) => _requested.ContainsKey(warehouseId);
}
