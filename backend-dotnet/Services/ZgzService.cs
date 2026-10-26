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
        var products = new Dictionary<string, (string Name, string Code, HashSet<string> Barcodes, Dictionary<string, decimal> Packs)>();
        var hus = new Dictionary<string, (string Source, string Target, string Executor, DateTime? At, Dictionary<string, decimal> Items)>();
        foreach (var r in rows)
        {
            var pid = r.ProductId != "" ? r.ProductId : (r.NomenclatureCode != "" ? r.NomenclatureCode : r.ProductName);
            if (!products.ContainsKey(pid))
                products[pid] = (r.ProductName, r.NomenclatureCode, new HashSet<string>(r.Barcodes == "" ? Array.Empty<string>() : r.Barcodes.Split('|')), new Dictionary<string, decimal>());
            if (!hus.TryGetValue(r.Hu, out var hu)) hus[r.Hu] = hu = (r.SourceCell, r.TargetCell, r.Executor, r.CompletedAt, new Dictionary<string, decimal>());
            // ЕО переводили несколько раз — место и исполнитель по последнему переводу
            if (r.CompletedAt > hu.At) hus[r.Hu] = hu = (hu.Source, r.TargetCell, r.Executor, r.CompletedAt, hu.Items);
            hu.Items[pid] = hu.Items.GetValueOrDefault(pid) + r.Quantity;
        }
        // Штрихкоды из файла весов («ШК товара») — в WMS у товара бывают не все,
        // и скан такого штрихкода не находился. Подмешиваем по артикулу.
        var codes = products.Values.Select(p => p.Code).Where(c => c != "").Distinct().ToList();
        if (codes.Count > 0)
        {
            var extra = await _db.Database
                .SqlQuery<BarcodeRow>($"SELECT barcode AS \"Barcode\", article AS \"Article\", qty AS \"Qty\" FROM product_barcodes WHERE article = ANY({codes})")
                .ToListAsync();
            var byArticle = extra.GroupBy(e => e.Article).ToDictionary(g => g.Key, g => g.ToList());
            foreach (var p in products.Values)
            {
                if (!byArticle.TryGetValue(p.Code, out var list)) continue;
                foreach (var e in list)
                {
                    // штрихкод упаковки (qty > 1) — скан засчитывается как её содержимое;
                    // если он же есть у товара как штучный (из WMS) — штучный главнее
                    if (e.Qty > 1 && !p.Barcodes.Contains(e.Barcode)) p.Packs[e.Barcode] = e.Qty;
                    else p.Barcodes.Add(e.Barcode);
                }
            }
        }

        var picks = await GetPicksAsync(hus.Keys.ToList(), fromUtc, toUtc);
        return new
        {
            rows = rows.Count,
            products = products.ToDictionary(kv => kv.Key, kv => (object)new { name = kv.Value.Name, code = kv.Value.Code, barcodes = kv.Value.Barcodes.ToArray(), packs = kv.Value.Packs }),
            hus = hus.Select(kv => new
            {
                hu = kv.Key,
                sourceCell = kv.Value.Source,
                targetCell = kv.Value.Target,
                executor = kv.Value.Executor,
                completedAt = kv.Value.At,
                // [товар, штук, кто комплектовал, когда (последняя раскладка)]
                items = kv.Value.Items.Select(i =>
                {
                    var p = picks.GetValueOrDefault((kv.Key, i.Key));
                    return new object?[] { i.Key, i.Value, p?.Executors, p?.LastAt };
                }).ToList(),
            }).ToList(),
        };
    }

    private sealed class BarcodeRow
    {
        public string Barcode { get; set; } = "";
        public string Article { get; set; } = "";
        public decimal Qty { get; set; }
    }

    private sealed class PickInfo
    {
        public HashSet<string> Names = new();
        public DateTime? LastAt;
        public string Executors => string.Join(", ", Names);
    }

    // Кто комплектовал: раскладка КДК (PICK_BY_LINE) и штучный отбор в хранении
    // (PIECE_SELECTION_PICKING) в эту ЕО (target HU) этого товара — из wms_ops
    // («Обновить данные» статистики). Ключ — (ЕО, товар) с тем же ключом
    // товара, что в выгрузке ЗГЗ (productId, иначе артикул). Комплектуют
    // раньше перевода в ЗГЗ — берём с запасом 2 дня до начала.
    private async Task<Dictionary<(string Hu, string Pid), PickInfo>> GetPicksAsync(List<string> hus, DateTime fromUtc, DateTime toUtc)
    {
        var result = new Dictionary<(string, string), PickInfo>();
        if (hus.Count == 0) return result;
        var fromDate = DateOnly.FromDateTime(ToMoscow(fromUtc)).AddDays(-2);
        var toDate = DateOnly.FromDateTime(ToMoscow(toUtc));
        var ops = await _db.WmsOps.AsNoTracking()
            .Where(o => o.Date >= fromDate && o.Date <= toDate
                && (o.OperationType == "PICK_BY_LINE" || o.OperationType == "PIECE_SELECTION_PICKING")
                && hus.Contains(o.TargetBarcode))
            .Select(o => new { o.TargetBarcode, o.ProductId, o.NomenclatureCode, o.ProductName, o.Executor, o.CompletedAt })
            .ToListAsync();
        foreach (var o in ops)
        {
            var pid = o.ProductId != "" ? o.ProductId : (o.NomenclatureCode != "" ? o.NomenclatureCode : o.ProductName);
            if (!result.TryGetValue((o.TargetBarcode, pid), out var p)) result[(o.TargetBarcode, pid)] = p = new PickInfo();
            if (!string.IsNullOrEmpty(o.Executor)) p.Names.Add(o.Executor);
            if (o.CompletedAt != null && (p.LastAt == null || o.CompletedAt > p.LastAt)) p.LastAt = o.CompletedAt;
        }
        return result;
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
