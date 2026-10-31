using System.Globalization;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Порт storage.js (Фаза 3) — 4 домена: ops (КДК/хранение), placement,
// receiving, remains. Таблицы созданы бэкфилл-скриптом (см.
// migrate-storage-json-to-pg.js), тот же принцип, что и в Фазах 1-2:
// dotnet только читает/пишет по готовой схеме, никакой EF-миграции.
//
// Компания резолвится НАПРЯМУЮ здесь (dotnet уже владеет таблицей
// employees с Фазы 2) — свежий SQL-запрос один раз за HTTP-запрос
// (GetIdMapAsync), без кэша, тот же принцип, что закреплён в Фазе 2 для
// getCompanyLookupMaps()/getCompanyByIdOrFioSync().
public partial class StatsService
{
    private readonly AppDbContext _db;
    private const long MoscowUtcOffsetMinutes = 3 * 60;
    private const long IdleThresholdMsDefault = 15 * 60 * 1000;
    private static readonly int[] DayHoursSummary = { 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 };
    private static readonly int[] NightHoursSummary = { 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 };
    private static readonly HashSet<string> FreezerZones = new() { "KDM", "MH" };

    public StatsService(AppDbContext db)
    {
        _db = db;
    }

    private static DateTime ToMoscow(DateTime utc) => utc.AddMinutes(MoscowUtcOffsetMinutes);

    // ─── Компания: свежая карта executorId->company, один запрос на HTTP-запрос ─

    public async Task<Dictionary<string, string>> GetIdMapAsync()
    {
        var rows = await _db.Employees.AsNoTracking()
            .Select(e => new { e.ExecutorId, e.Company })
            .ToListAsync();
        var map = new Dictionary<string, string>();
        foreach (var r in rows)
        {
            if (!string.IsNullOrEmpty(r.ExecutorId)) map[r.ExecutorId] = r.Company ?? "";
        }
        return map;
    }

    private static string? ResolveCompany(Dictionary<string, string>? idMap, string? executorId)
    {
        if (string.IsNullOrEmpty(executorId) || idMap == null) return null;
        // Сотрудник может существовать в реестре, но без назначенной компании
        // (company = "" в базе, не NULL) — пустую строку нужно приравнивать к
        // «не нашли», иначе она проходит мимо `?? "—"` у всех вызывающих (в C#
        // `??` не ловит "", в отличие от JS-оригинала, где `r.company || '—'`
        // ловит и то, и другое) — именно так пустая ячейка «Компания» в
        // сводке долетала до фронтенда вместо «—» (пользователь 2026-07-16).
        return idMap.TryGetValue(executorId, out var c) && !string.IsNullOrEmpty(c) ? c : null;
    }

    // ─── Веса товаров (product_weights) — свежий запрос, без кэша ──────────────

    public async Task<Dictionary<string, decimal>> GetWeightMapAsync()
    {
        var rows = await _db.ProductWeights.AsNoTracking().ToListAsync();
        var map = new Dictionary<string, decimal>();
        foreach (var r in rows) map[r.Article] = r.Grams;
        return map;
    }

    private static decimal GetWeightGrams(Dictionary<string, decimal> weightMap, string? article)
    {
        var a = (article ?? "").Trim();
        return a != "" && weightMap.TryGetValue(a, out var g) ? g : 0;
    }

    // ─── Merge-key (аналог getMergeKeyFromLight из storage.js) ─────────────────
    //
    // PICK_BY_LINE (КДК) — составной ключ исполнитель+ячейка+товар: одна и та
    // же раскладка может прийти несколькими сырыми записями, их нужно
    // схлопнуть в одну. PIECE_SELECTION_PICKING (Хранение) — тоже составной
    // ключ, но с добавлением штрихкода тары-получателя (targetBarcode): один
    // и тот же физический отбор WMS может прислать несколькими записями с
    // РАЗНЫМИ id (например, отбор в несколько заходов в одну и ту же тару) —
    // их нужно схлопывать в одну, как и раньше. При этом тот же товар из той
    // же ячейки, но в РАЗНУЮ тару (= другой заказ) — это разные СЗ,
    // схлопывать нельзя. Штрихкод тары различает именно это: одна тара —
    // один реальный отбор, разные тары — разные заказы.
    // (2026-07-27: сначала пробовали дедуп по голому `id` записи — оказалось,
    // что id уникален на каждую под-запись одного и того же отбора, а не на
    // сам отбор, из-за чего счётчик СЗ устойчиво завышался в разы и
    // продолжал расти дальше.)
    private static string GetMergeKeyFromLight(string? operationType, string? type, string? executor, string? cell, string? nomenclatureCode, string? productName, string? itemId, string? targetBarcode = null)
    {
        var t = (operationType ?? type ?? "").ToUpperInvariant();
        if (t == "PICK_BY_LINE")
        {
            var exec = executor ?? "";
            var c = cell ?? "";
            var product = !string.IsNullOrEmpty(nomenclatureCode) ? nomenclatureCode : (productName ?? "");
            return $"task|{exec}|{c}|{product}";
        }
        if (t == "PIECE_SELECTION_PICKING")
        {
            var exec = executor ?? "";
            var c = cell ?? "";
            var product = !string.IsNullOrEmpty(nomenclatureCode) ? nomenclatureCode : (productName ?? "");
            var tb = targetBarcode ?? "";
            return $"piece|{exec}|{c}|{product}|{tb}";
        }
        return $"id|{itemId ?? ""}";
    }

    private static string GetTaskKeySummary(WmsOpEntity item)
    {
        var type = (item.OperationType ?? "").ToUpperInvariant();
        if (type == "PICK_BY_LINE")
        {
            var exec = item.ExecutorId ?? "";
            var cell = item.Cell ?? "";
            var product = !string.IsNullOrEmpty(item.NomenclatureCode) ? item.NomenclatureCode : (item.ProductName ?? "");
            return $"kdk|{exec}|{cell}|{product}";
        }
        if (!string.IsNullOrEmpty(item.ItemId)) return $"op|{item.ItemId}";
        var ts = item.CompletedAt ?? item.StartedAt;
        var tsStr = ts.HasValue ? ts.Value.ToString("o", CultureInfo.InvariantCulture) : "";
        return $"op|{tsStr}|{item.Executor ?? ""}|{item.Cell ?? ""}";
    }

    private static void AddWeight(Dictionary<string, (decimal Storage, decimal Kdk, decimal Total)> map, string key, decimal grams, bool isKdk)
    {
        if (string.IsNullOrEmpty(key) || grams <= 0) return;
        (decimal Storage, decimal Kdk, decimal Total) cur = map.TryGetValue(key, out var v) ? v : (0, 0, 0);
        if (isKdk) cur.Kdk += grams; else cur.Storage += grams;
        cur.Total = cur.Storage + cur.Kdk;
        map[key] = cur;
    }

    // ─── Часы для чтения (аналог getHoursToLoad) ────────────────────────────────

    private static List<(DateOnly Date, int Hour)> GetHoursToLoad(DateOnly dateStr, int? fromHour, int? toHour, string? shift)
    {
        var pairs = new List<(DateOnly, int)>();
        if (shift == "night")
        {
            var next = dateStr.AddDays(1);
            foreach (var h in new[] { 21, 22, 23 }) pairs.Add((dateStr, h));
            for (var h = 0; h <= 8; h++) pairs.Add((next, h));
            return pairs;
        }
        if (shift == "day")
        {
            for (var h = 9; h <= 20; h++) pairs.Add((dateStr, h));
            return pairs;
        }
        if (fromHour != null || toHour != null)
        {
            var from = fromHour == null ? 0 : Math.Max(0, fromHour.Value);
            var to = toHour == null ? 23 : Math.Min(23, toHour.Value);
            for (var h = from; h <= to; h++) pairs.Add((dateStr, h));
            return pairs;
        }
        var prev = dateStr.AddDays(-1);
        foreach (var h in new[] { 21, 22, 23 }) pairs.Add((prev, h));
        for (var h = 0; h <= 23; h++) pairs.Add((dateStr, h));
        return pairs;
    }

    // ─── Диапазон дат (аналог getDateRangeList) ─────────────────────────────────

    public static List<string> GetDateRangeList(string fromStr, string toStr)
    {
        if (!DateOnly.TryParse(fromStr, out var from) || !DateOnly.TryParse(toStr, out var to)) return new();
        if (from > to) return new();
        var result = new List<string>();
        for (var d = from; d <= to; d = d.AddDays(1)) result.Add(d.ToString("yyyy-MM-dd"));
        return result;
    }

    // ─── POST /api/date/:date/storage ───────────────────────────────────────────
    // getStorageForDate (чтение обратно) — подтверждённый мёртвый код в оригинале
    // (нет вызывающих), поэтому только запись — см. Models/StatsModels.cs.

    public async Task SaveStorageForDateAsync(string dateStr, SaveStorageRequest req)
    {
        var date = DateOnly.Parse(dateStr);
        var shift = req.Shift == "night" ? "night" : "day";
        var existing = await _db.WmsStorageAgg.FirstOrDefaultAsync(s => s.Date == date && s.Shift == shift);
        var storageByHour = req.StorageByHour ?? new Dictionary<string, decimal>();
        var weightByEmployee = req.WeightByEmployee ?? new Dictionary<string, decimal>();
        if (existing != null)
        {
            existing.TotalStorageCount = req.TotalStorageCount ?? 0;
            existing.StorageByHour = storageByHour;
            existing.TotalWeightGrams = req.TotalWeightGrams ?? 0;
            existing.WeightByEmployee = weightByEmployee;
        }
        else
        {
            _db.WmsStorageAgg.Add(new WmsStorageAggEntity
            {
                Date = date,
                Shift = shift,
                TotalStorageCount = req.TotalStorageCount ?? 0,
                StorageByHour = storageByHour,
                TotalWeightGrams = req.TotalWeightGrams ?? 0,
                WeightByEmployee = weightByEmployee,
            });
        }
        await _db.SaveChangesAsync();
    }
}
