using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// «Поиск потеряшек»: хранение переводов ЕО в ЗГЗ, чтобы к выгрузке можно
// было возвращаться несколько раз и с разных устройств. Данные — по складу.
public class ZgzService
{
    private readonly AppDbContext _db;
    public ZgzService(AppDbContext db) { _db = db; }

    private static DateTime ToMoscow(DateTime utc) => utc.AddHours(3);

    // Вставка пачкой через unnest: повтор строки WMS (тот же id) отсекается
    // уникальным индексом (warehouse_id, date, hour, merge_key) — за сутки
    // сотни тысяч строк, поштучный EF здесь был бы слишком медленным.
    public async Task<int> SaveAsync(List<ZgzRow> rows)
    {
        var valid = rows.Where(r => !string.IsNullOrWhiteSpace(r.Id) && !string.IsNullOrWhiteSpace(r.Hu) && r.CompletedAt != null).ToList();
        if (valid.Count == 0) return 0;
        var completed = valid.Select(r => DateTime.SpecifyKind(r.CompletedAt!.Value, DateTimeKind.Utc)).ToArray();
        var msk = completed.Select(ToMoscow).ToArray();
        var sql = @"
            INSERT INTO wms_zgz_moves (warehouse_id, date, hour, merge_key, hu, source_cell, target_cell, product_id, product_name, nomenclature_code, barcodes, quantity, executor_id, executor, completed_at)
            SELECT @wh, d, h, k, hu, sc, tc, pid, pn, nc, bc, q, eid, ex, ca
              FROM unnest(@d, @h, @k, @hu, @sc, @tc, @pid, @pn, @nc, @bc, @q, @eid, @ex, @ca)
                   AS t(d, h, k, hu, sc, tc, pid, pn, nc, bc, q, eid, ex, ca)
            ON CONFLICT (warehouse_id, date, hour, merge_key) DO NOTHING";
        var p = new List<NpgsqlParameter>
        {
            new("wh", _db.WarehouseId),
            new("d", NpgsqlDbType.Array | NpgsqlDbType.Date) { Value = msk.Select(DateOnly.FromDateTime).ToArray() },
            new("h", NpgsqlDbType.Array | NpgsqlDbType.Smallint) { Value = msk.Select(m => (short)m.Hour).ToArray() },
            new("k", valid.Select(r => r.Id!.Trim()).ToArray()),
            new("hu", valid.Select(r => r.Hu!.Trim()).ToArray()),
            new("sc", valid.Select(r => r.SourceCell ?? "").ToArray()),
            new("tc", valid.Select(r => r.TargetCell ?? "").ToArray()),
            new("pid", valid.Select(r => r.ProductId ?? "").ToArray()),
            new("pn", valid.Select(r => r.Name ?? "").ToArray()),
            new("nc", valid.Select(r => r.Code ?? "").ToArray()),
            new("bc", valid.Select(r => string.Join("|", r.Barcodes ?? new())).ToArray()),
            new("q", NpgsqlDbType.Array | NpgsqlDbType.Numeric) { Value = valid.Select(r => r.Qty is > 0 ? r.Qty!.Value : 1m).ToArray() },
            new("eid", valid.Select(r => r.ExecutorId ?? "").ToArray()),
            new("ex", valid.Select(r => r.Executor ?? "").ToArray()),
            new("ca", NpgsqlDbType.Array | NpgsqlDbType.TimestampTz) { Value = completed },
        };
        return await _db.Database.ExecuteSqlRawAsync(sql, p.Cast<object>().ToArray());
    }

    // Выгрузка для поиска за интервал времени перевода — сжато: справочник
    // товаров отдельно, у ЕО только [productId, qty] (иначе названия и
    // штрихкоды повторялись бы в каждой ЕО и ответ раздувался в разы).
    public async Task<object> GetAsync(DateTime fromUtc, DateTime toUtc)
    {
        var rows = await _db.WmsZgzMoves.AsNoTracking()
            .Where(m => m.CompletedAt >= fromUtc && m.CompletedAt <= toUtc)
            .ToListAsync();
        var products = new Dictionary<string, object>();
        var hus = new Dictionary<string, (string Source, string Target, string Executor, DateTime? At, Dictionary<string, decimal> Items)>();
        foreach (var r in rows)
        {
            var pid = r.ProductId != "" ? r.ProductId : (r.NomenclatureCode != "" ? r.NomenclatureCode : r.ProductName);
            if (!products.ContainsKey(pid))
                products[pid] = new { name = r.ProductName, code = r.NomenclatureCode, barcodes = r.Barcodes == "" ? Array.Empty<string>() : r.Barcodes.Split('|') };
            if (!hus.TryGetValue(r.Hu, out var hu)) hus[r.Hu] = hu = (r.SourceCell, r.TargetCell, r.Executor, r.CompletedAt, new Dictionary<string, decimal>());
            // ЕО переводили несколько раз — место и исполнитель по последнему переводу
            if (r.CompletedAt > hu.At) hus[r.Hu] = hu = (hu.Source, r.TargetCell, r.Executor, r.CompletedAt, hu.Items);
            hu.Items[pid] = hu.Items.GetValueOrDefault(pid) + r.Quantity;
        }
        return new
        {
            rows = rows.Count,
            products,
            hus = hus.Select(kv => new
            {
                hu = kv.Key,
                sourceCell = kv.Value.Source,
                targetCell = kv.Value.Target,
                executor = kv.Value.Executor,
                completedAt = kv.Value.At,
                items = kv.Value.Items.Select(i => new object[] { i.Key, i.Value }).ToList(),
            }).ToList(),
        };
    }

    // Что лежит на сервере: строки, ЕО, диапазон времени переводов.
    public async Task<object> InfoAsync()
    {
        var q = _db.WmsZgzMoves.AsNoTracking();
        var count = await q.CountAsync();
        if (count == 0) return new { rows = 0 };
        return new
        {
            rows = count,
            hus = await q.Select(m => m.Hu).Distinct().CountAsync(),
            from = await q.MinAsync(m => m.CompletedAt),
            to = await q.MaxAsync(m => m.CompletedAt),
        };
    }

    private IQueryable<WmsZgzMoveEntity> InRange(string? dateFrom, string? dateTo)
    {
        var q = _db.WmsZgzMoves.AsQueryable();
        if (DateOnly.TryParse(dateFrom, out var f)) q = q.Where(m => m.Date >= f);
        if (DateOnly.TryParse(dateTo, out var t)) q = q.Where(m => m.Date <= t);
        return q;
    }

    public Task<int> CountAsync(string? dateFrom, string? dateTo) => InRange(dateFrom, dateTo).CountAsync();
    public Task<int> DeleteAsync(string? dateFrom, string? dateTo) => InRange(dateFrom, dateTo).ExecuteDeleteAsync();
}
