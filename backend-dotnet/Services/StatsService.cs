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
public class StatsService
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
    // схлопнуть в одну. PIECE_SELECTION_PICKING (Хранение) — НЕ составной
    // ключ, а `id` самой записи (общий случай ниже): это законченная
    // операция отбора (operationStartedAt/operationCompletedAt) со своим
    // стабильным id из WMS, и один и тот же товар из одной и той же ячейки
    // МОЖЕТ браться повторно под разные заказы в течение часа — это разные
    // СЗ, схлопывать их по исполнитель+ячейка+товар нельзя (был баг,
    // 2026-07-27: подтверждено вживую структурой ответа WMS — id уникален на
    // операцию, а не на исполнитель+ячейку+товар).
    private static string GetMergeKeyFromLight(string? operationType, string? type, string? executor, string? cell, string? nomenclatureCode, string? productName, string? itemId)
    {
        var t = (operationType ?? type ?? "").ToUpperInvariant();
        if (t == "PICK_BY_LINE")
        {
            var exec = executor ?? "";
            var c = cell ?? "";
            var product = !string.IsNullOrEmpty(nomenclatureCode) ? nomenclatureCode : (productName ?? "");
            return $"task|{exec}|{c}|{product}";
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

    // ─── Ops: чтение ─────────────────────────────────────────────────────────

    public async Task<List<WmsOpEntity>> GetDateItemsAsync(string dateStr, int? fromHour, int? toHour, string? shift)
    {
        var date = DateOnly.Parse(dateStr);
        var pairs = GetHoursToLoad(date, fromHour, toHour, shift);
        var dates = pairs.Select(p => p.Date).Distinct().ToList();
        var hours = pairs.Select(p => p.Hour).Distinct().ToList();
        // Достаём с запасом (по датам/часам-кандидатам), затем фильтруем в памяти
        // точным набором пар (date,hour) — то же самое, что делает JS, читая
        // файл-по-файлу по списку пар.
        var candidates = await _db.WmsOps.AsNoTracking()
            .Where(o => dates.Contains(o.Date) && hours.Contains((int)o.Hour))
            .ToListAsync();
        var pairSet = new HashSet<(DateOnly, int)>(pairs);
        var filtered = candidates.Where(o => pairSet.Contains((o.Date, (int)o.Hour)));

        var byId = new Dictionary<string, WmsOpEntity>();
        foreach (var item in filtered)
        {
            var key = !string.IsNullOrEmpty(item.ItemId) ? item.ItemId
                : $"{item.CompletedAt:o}{item.Executor}{item.Cell}";
            if (!byId.ContainsKey(key)) byId[key] = item;
        }
        var items = byId.Values.ToList();
        items.Sort((a, b) => string.CompareOrdinal(
            (a.CompletedAt ?? a.StartedAt)?.ToString("o") ?? "",
            (b.CompletedAt ?? b.StartedAt)?.ToString("o") ?? ""));
        return items;
    }

    // ─── Сводка (аналог getDateSummary → buildSummaryFromItems) ────────────────

    public async Task<DateSummaryResult> GetDateSummaryAsync(string dateStr, string? shift, long? idleThresholdMs, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var items = await GetDateItemsAsync(dateStr, null, null, shift);
        if (!string.IsNullOrEmpty(filterExecutorNorm))
        {
            items = items.Where(it => NormalizeFioSummary(it.Executor) == filterExecutorNorm).ToList();
        }
        if (filterCompanies != null && filterCompanies.Count > 0 && idMap != null)
        {
            // ВОСПРОИЗВЕДЕНО НАМЕРЕННО: оригинал (storage.js:1356-1361, getDateSummary)
            // вызывает context.getCompany(it.executor) — ОДНИМ аргументом, хотя
            // getCompany = (fio, id) => getCompanyByIdOrFioSync(idMap, id, fio) ждёт
            // executorId вторым. В результате id всегда undefined, company всегда
            // null, и этот фильтр в оригинале ВСЕГДА обнуляет items, если
            // filterCompanies задан (похоже на баг оригинала — у getPlacementSummary/
            // getReceivingSummary/getRemainsSummary тот же фильтр вызывает
            // getCompany(it.executor, it.executorId), 2 аргумента, без этой проблемы).
            // Порт сохраняет точное поведение — не наша задача тихо чинить баги
            // при переносе.
            var allowed = new HashSet<string>(filterCompanies.Select(c => c.Trim().ToLowerInvariant()));
            items = items.Where(it =>
            {
                var company = ResolveCompany(idMap, null);
                return !string.IsNullOrEmpty(company) && allowed.Contains(company.Trim().ToLowerInvariant());
            }).ToList();
        }
        var weightMap = await GetWeightMapAsync();
        return BuildSummaryFromItems(items, shift, dateStr, idMap, idleThresholdMs, weightMap);
    }

    private static string NormalizeFioSummary(string? s) =>
        System.Text.RegularExpressions.Regex.Replace((s ?? "").Trim(), @"\s+", " ").ToLowerInvariant();

    private static string GetMoscowTodayStr() => ToMoscow(DateTime.UtcNow).ToString("yyyy-MM-dd");

    private static string FormatTimeMoscow(long? epochMs)
    {
        if (epochMs == null || epochMs == 0) return "—";
        var utc = DateTimeOffset.FromUnixTimeMilliseconds(epochMs.Value).UtcDateTime;
        var m = ToMoscow(utc);
        return $"{m.Hour:D2}:{m.Minute:D2}";
    }

    private static List<int> GetHoursDisplayForSummary(string dateStr, string? shift)
    {
        var order = (shift == "night" ? NightHoursSummary : DayHoursSummary).ToList();
        var todayStr = GetMoscowTodayStr();
        if (dateStr != todayStr) return order;
        var m = ToMoscow(DateTime.UtcNow);
        var currentHour = m.Hour;
        if (shift == "day")
        {
            var currentCol = currentHour + 1;
            var passed = order.Where(col => col <= currentHour).ToList();
            var withCurrent = order.Where(col => col <= currentCol).ToList();
            if (withCurrent.Count > passed.Count)
            {
                var result = new List<int>(passed) { currentCol };
                result.Sort();
                return result;
            }
            return passed;
        }
        var currentColNight = (currentHour + 1) % 24;
        var passedNight = order.Where(col => col >= 22 || col <= currentHour).ToList();
        return order.Where(col => passedNight.Contains(col) || col == currentColNight).ToList();
    }

    // ─── Простои по сотрудникам (аналог calcIdlesByEmployeeSummary) ────────────

    private static Dictionary<string, object> CalcIdlesByEmployeeSummary(List<WmsOpEntity> items, long idleThresholdMs, long shiftStartMs, long shiftEndMs)
    {
        var byExecutor = new Dictionary<string, (string Name, List<long> Times)>();
        foreach (var item in items)
        {
            var executorId = item.ExecutorId ?? "";
            if (string.IsNullOrEmpty(executorId)) continue;
            var ts = item.CompletedAt;
            if (ts == null) continue;
            var name = !string.IsNullOrEmpty(item.Executor) ? item.Executor : executorId;
            if (!byExecutor.TryGetValue(executorId, out var rec))
            {
                rec = (name, new List<long>());
                byExecutor[executorId] = rec;
            }
            rec.Times.Add(new DateTimeOffset(DateTime.SpecifyKind(ts.Value, DateTimeKind.Utc)).ToUnixTimeMilliseconds());
        }
        var outMap = new Dictionary<string, object>();
        foreach (var (executorId, rec) in byExecutor)
        {
            var times = rec.Times;
            if (times.Count == 0) continue;
            times.Sort();
            var idles = new List<string>();
            long totalMs = 0;
            if (shiftStartMs > 0 && times[0] - shiftStartMs >= idleThresholdMs)
            {
                idles.Add($"{FormatTimeMoscow(shiftStartMs)}–{FormatTimeMoscow(times[0])}");
                totalMs += times[0] - shiftStartMs;
            }
            for (var i = 1; i < times.Count; i++)
            {
                var gap = times[i] - times[i - 1];
                if (gap >= idleThresholdMs)
                {
                    idles.Add($"{FormatTimeMoscow(times[i - 1])}–{FormatTimeMoscow(times[i])}");
                    totalMs += gap;
                }
            }
            if (shiftEndMs > 0 && shiftEndMs - times[^1] >= idleThresholdMs)
            {
                idles.Add($"{FormatTimeMoscow(times[^1])}–{FormatTimeMoscow(shiftEndMs)}");
                totalMs += shiftEndMs - times[^1];
            }
            if (idles.Count > 0)
            {
                outMap[executorId] = new { intervals = string.Join(", ", idles), totalMinutes = (long)Math.Round(totalMs / 60000.0) };
            }
        }
        return outMap;
    }

    // ─── Главная сводка (аналог buildSummaryFromItems, storage.js:410-728) ─────

    public DateSummaryResult BuildSummaryFromItems(List<WmsOpEntity> items, string? shift, string? dateStr, Dictionary<string, string>? idMap, long? idleThresholdMsOpt, Dictionary<string, decimal> weightMap)
    {
        var taskKeys = new HashSet<string>(items.Select(GetTaskKeySummary));
        var totalOps = taskKeys.Count;
        var totalQty = items.Sum(i => i.Quantity ?? 0);

        decimal totalWeightStorageGrams = 0, totalWeightKdkGrams = 0;
        var weightByEmployee = new Dictionary<string, (decimal Storage, decimal Kdk, decimal Total)>();
        var weightByCompany = new Dictionary<string, (decimal Storage, decimal Kdk, decimal Total)>();
        var missingWeightMap = new Dictionary<string, (string Name, string Article)>();

        foreach (var item in items)
        {
            var type = (item.OperationType ?? "").ToUpperInvariant();
            var isKdk = type == "PICK_BY_LINE";
            if (!isKdk && type != "PIECE_SELECTION_PICKING") continue;
            var name = item.ProductName;
            if (string.IsNullOrEmpty(name)) continue;
            var article = (item.NomenclatureCode ?? "").Trim();
            var gramsPerUnit = GetWeightGrams(weightMap, article);
            if (gramsPerUnit <= 0)
            {
                var key = article != "" ? article : name.Trim();
                if (!missingWeightMap.ContainsKey(key)) missingWeightMap[key] = (name.Trim(), article);
                continue;
            }
            var qty = Math.Max(1, item.Quantity ?? 1);
            var grams = gramsPerUnit * qty;
            var emp = item.ExecutorId ?? "";
            if (!string.IsNullOrEmpty(emp)) AddWeight(weightByEmployee, emp, grams, isKdk);
            if (idMap != null && !string.IsNullOrEmpty(item.ExecutorId))
            {
                var c = ResolveCompany(idMap, item.ExecutorId) ?? "—";
                AddWeight(weightByCompany, c, grams, isKdk);
            }
            if (isKdk) totalWeightKdkGrams += grams; else totalWeightStorageGrams += grams;
        }

        var byExecutor = new Dictionary<string, (string Name, string ExecutorId, HashSet<string> TaskKeys, decimal Qty, DateTime? FirstAt, DateTime? LastAt)>();
        foreach (var item in items)
        {
            var key = item.ExecutorId ?? "";
            if (string.IsNullOrEmpty(key)) continue;
            if (!byExecutor.TryGetValue(key, out var e))
            {
                e = (!string.IsNullOrEmpty(item.Executor) ? item.Executor : key, key, new HashSet<string>(), 0, null, null);
            }
            e.TaskKeys.Add(GetTaskKeySummary(item));
            e.Qty += item.Quantity ?? 0;
            var ts = item.CompletedAt ?? item.StartedAt;
            if (ts != null)
            {
                if (e.FirstAt == null || ts < e.FirstAt) e.FirstAt = ts;
                if (e.LastAt == null || ts > e.LastAt) e.LastAt = ts;
            }
            byExecutor[key] = e;
        }
        var executors = byExecutor.Values.Select(e => new
        {
            name = e.Name,
            executorId = (string?)e.ExecutorId,
            ops = e.TaskKeys.Count,
            qty = e.Qty,
            firstAt = e.FirstAt,
            lastAt = e.LastAt,
        }).OrderByDescending(e => e.ops).ToList();

        var byHour = new Dictionary<int, (HashSet<string> TaskKeys, HashSet<string> KdkTaskKeys, HashSet<string> Employees, HashSet<string> KomplEmployees, Dictionary<string, (int KdkNonFreezer, int KdkFreezer, int Storage, int StorageFreezer)> EmployeeOpCounts, int StorageOps)>();
        foreach (var item in items)
        {
            var ts = item.CompletedAt;
            if (ts == null) continue;
            var h = ToMoscow(ts.Value).Hour;
            if (!byHour.TryGetValue(h, out var hh))
            {
                hh = (new HashSet<string>(), new HashSet<string>(), new HashSet<string>(), new HashSet<string>(), new Dictionary<string, (int, int, int, int)>(), 0);
            }
            var type = (item.OperationType ?? "").ToUpperInvariant();
            var isKdk = type == "PICK_BY_LINE";
            var isStor = type == "PIECE_SELECTION_PICKING";
            var tk = GetTaskKeySummary(item);
            hh.TaskKeys.Add(tk);
            if (isKdk) hh.KdkTaskKeys.Add(tk);
            else if (isStor) hh.StorageOps++;
            var exec = item.ExecutorId;
            if (!string.IsNullOrEmpty(exec))
            {
                hh.Employees.Add(exec);
                var zone = (item.Cell ?? "").Split('-')[0].ToUpperInvariant();
                if (!FreezerZones.Contains(zone)) hh.KomplEmployees.Add(exec);
                if (isKdk || isStor)
                {
                    (int KdkNonFreezer, int KdkFreezer, int Storage, int StorageFreezer) counts = hh.EmployeeOpCounts.TryGetValue(exec, out var c0) ? c0 : (0, 0, 0, 0);
                    if (isStor && zone == "MH") counts.StorageFreezer++;
                    else if (isStor) counts.Storage++;
                    else if (isKdk && zone == "KDM") counts.KdkFreezer++;
                    else if (isKdk) counts.KdkNonFreezer++;
                    hh.EmployeeOpCounts[exec] = counts;
                }
            }
            byHour[h] = hh;
        }
        var hourly = byHour.Select(kv =>
        {
            var (hour, x) = (kv.Key, kv.Value);
            int kdkEmpCount = 0, storageEmpCount = 0;
            foreach (var counts in x.EmployeeOpCounts.Values)
            {
                var maxCount = new[] { counts.KdkNonFreezer, counts.KdkFreezer, counts.Storage, counts.StorageFreezer }.Max();
                if (maxCount == 0) continue;
                if (counts.KdkNonFreezer == maxCount) kdkEmpCount++;
                else if (counts.Storage == maxCount) storageEmpCount++;
            }
            return new
            {
                hour,
                ops = x.TaskKeys.Count,
                employees = x.Employees.Count,
                employeesKompl = x.KomplEmployees.Count,
                kdkEmployees = kdkEmpCount,
                storageEmployees = storageEmpCount,
                storageOps = x.StorageOps,
                kdkOps = x.KdkTaskKeys.Count,
            };
        }).OrderBy(h => h.hour).ToList();

        DateTime? firstAt = null, lastAt = null;
        foreach (var item in items)
        {
            var ts = item.CompletedAt;
            if (ts == null) continue;
            if (firstAt == null || ts < firstAt) firstAt = ts;
            if (lastAt == null || ts > lastAt) lastAt = ts;
        }

        object companySummary = new { rows = new List<object>(), hoursDisplay = new List<int>() };
        var hourlyByEmployee = new HourlyByEmployeeResult();

        if (!string.IsNullOrEmpty(shift) && !string.IsNullOrEmpty(dateStr))
        {
            var order = (shift == "night" ? NightHoursSummary : DayHoursSummary).ToList();
            string ResolveCompanyForRow(string? executorId) =>
                idMap != null && !string.IsNullOrEmpty(executorId) ? (ResolveCompany(idMap, executorId) ?? "—") : "—";

            var byEmployeeHour = new Dictionary<string, (string Name, Dictionary<int, (int PieceSelectionCount, HashSet<string> KdkSet, decimal WeightGrams, Dictionary<string, int> ZoneCounts, Dictionary<string, decimal> ZoneWeights)> HourMap)>();
            foreach (var item in items)
            {
                var ts = item.CompletedAt;
                if (ts == null) continue;
                var h = ToMoscow(ts.Value).Hour;
                var col = (h + 1) % 24;
                var executorId = item.ExecutorId ?? "";
                if (string.IsNullOrEmpty(executorId)) continue;
                if (!byEmployeeHour.TryGetValue(executorId, out var rec))
                {
                    rec = (!string.IsNullOrEmpty(item.Executor) ? item.Executor : executorId, new Dictionary<int, (int, HashSet<string>, decimal, Dictionary<string, int>, Dictionary<string, decimal>)>());
                }
                var hourMap = rec.HourMap;
                if (!hourMap.TryGetValue(col, out var cell))
                {
                    cell = (0, new HashSet<string>(), 0, new Dictionary<string, int>(), new Dictionary<string, decimal>());
                }
                var type = (item.OperationType ?? "").ToUpperInvariant();
                if (type == "PIECE_SELECTION_PICKING") cell.Item1++;
                else if (type == "PICK_BY_LINE")
                {
                    var productId = !string.IsNullOrEmpty(item.NomenclatureCode) ? item.NomenclatureCode : (!string.IsNullOrEmpty(item.ProductName) ? item.ProductName : "no-product");
                    var targetCell = !string.IsNullOrEmpty(item.Cell) ? item.Cell : "no-target-cell";
                    cell.Item2.Add($"{productId}||{targetCell}");
                }
                if (type == "PIECE_SELECTION_PICKING" || type == "PICK_BY_LINE")
                {
                    var zoneKey = (item.Cell ?? "").Split('-')[0].ToUpperInvariant();
                    if (zoneKey != "") cell.Item4[zoneKey] = cell.Item4.GetValueOrDefault(zoneKey) + 1;
                    var productName = item.ProductName;
                    if (!string.IsNullOrEmpty(productName))
                    {
                        var itemArticle = (item.NomenclatureCode ?? "").Trim();
                        var gramsPerUnit = GetWeightGrams(weightMap, itemArticle);
                        if (gramsPerUnit > 0)
                        {
                            var qty = Math.Max(1, item.Quantity ?? 1);
                            var grams = gramsPerUnit * qty;
                            cell.Item3 += grams;
                            if (zoneKey != "") cell.Item5[zoneKey] = cell.Item5.GetValueOrDefault(zoneKey) + grams;
                        }
                    }
                }
                hourMap[col] = cell;
                rec.HourMap[col] = cell;
                byEmployeeHour[executorId] = rec;
            }

            var heRows = new List<Dictionary<string, object?>>();
            foreach (var (executorId, rec) in byEmployeeHour)
            {
                var name = rec.Name;
                var hourMap = rec.HourMap;
                var byHourRow = new Dictionary<string, object?>();
                var weightByHour = new Dictionary<string, object?>();
                var byHourZone = new Dictionary<string, object?>();
                var byZone = new Dictionary<string, object?>();
                var total = 0;
                foreach (var col in order)
                {
                    if (!hourMap.TryGetValue(col, out var cell))
                    {
                        byHourRow[col.ToString()] = 0;
                        weightByHour[col.ToString()] = 0;
                        byHourZone[col.ToString()] = null;
                        continue;
                    }
                    var sz = cell.Item1 + cell.Item2.Count;
                    byHourRow[col.ToString()] = sz;
                    weightByHour[col.ToString()] = cell.Item3;
                    {
                        var totalCnt = cell.Item4.Values.Sum();
                        var totalWg = cell.Item5.Values.Sum();
                        var allZk = new HashSet<string>(cell.Item4.Keys.Concat(cell.Item5.Keys));
                        string? domKey = null; double domScore = -1;
                        foreach (var zk in allZk)
                        {
                            var scoreCnt = totalCnt > 0 ? (double)cell.Item4.GetValueOrDefault(zk) / totalCnt : 0;
                            var scoreWg = totalWg > 0 ? (double)cell.Item5.GetValueOrDefault(zk) / (double)totalWg : 0;
                            var score = totalWg > 0 ? (scoreCnt + scoreWg) / 2 : scoreCnt;
                            if (score > domScore) { domScore = score; domKey = zk; }
                        }
                        byHourZone[col.ToString()] = domKey;
                    }
                    foreach (var (zk, cnt) in cell.Item4)
                    {
                        if (!byZone.ContainsKey(zk)) byZone[zk] = new Dictionary<string, object?> { ["count"] = 0, ["weightGrams"] = (decimal)0 };
                        var z = (Dictionary<string, object?>)byZone[zk]!;
                        z["count"] = (int)z["count"]! + cnt;
                    }
                    foreach (var (zk, wg) in cell.Item5)
                    {
                        if (!byZone.ContainsKey(zk)) byZone[zk] = new Dictionary<string, object?> { ["count"] = 0, ["weightGrams"] = (decimal)0 };
                        var z = (Dictionary<string, object?>)byZone[zk]!;
                        z["weightGrams"] = (decimal)z["weightGrams"]! + wg;
                    }
                    total += sz;
                }
                var execInfo = byExecutor.TryGetValue(executorId, out var ei) ? ei : default;
                heRows.Add(new Dictionary<string, object?>
                {
                    ["name"] = name,
                    ["executorId"] = executorId,
                    ["company"] = ResolveCompanyForRow(executorId),
                    ["byHour"] = byHourRow,
                    ["weightByHour"] = weightByHour,
                    ["byHourZone"] = byHourZone,
                    ["byZone"] = byZone,
                    ["total"] = total,
                    ["firstAt"] = execInfo.FirstAt,
                    ["lastAt"] = execInfo.LastAt,
                });
            }

            hourlyByEmployee = new HourlyByEmployeeResult { Hours = order, Rows = heRows };

            var byCompany = new Dictionary<string, List<Dictionary<string, object?>>>();
            foreach (var r in heRows)
            {
                var c = (string?)r["company"] ?? "—";
                if (!byCompany.TryGetValue(c, out var list)) { list = new(); byCompany[c] = list; }
                list.Add(r);
            }
            foreach (var list in byCompany.Values) list.Sort((a, b) => (int)b["total"]! - (int)a["total"]!);

            var szByCompany = new Dictionary<string, (int Storage, int Kdk)>();
            foreach (var item in items)
            {
                var type = (item.OperationType ?? "").ToUpperInvariant();
                var isKdk = type == "PICK_BY_LINE";
                if (!isKdk && type != "PIECE_SELECTION_PICKING") continue;
                var c = ResolveCompanyForRow(item.ExecutorId);
                (int Storage, int Kdk) entry = szByCompany.TryGetValue(c, out var e2) ? e2 : (0, 0);
                if (isKdk) entry.Kdk += 1; else entry.Storage += 1;
                szByCompany[c] = entry;
            }

            var companyTotals = new Dictionary<string, int>();
            foreach (var (c, arr) in byCompany) companyTotals[c] = arr.Sum(r => (int)r["total"]!);
            var companiesOrder = byCompany.Keys.OrderByDescending(c => companyTotals.GetValueOrDefault(c)).ToList();
            var hoursDisplay = GetHoursDisplayForSummary(dateStr, shift);
            var passedHours = hoursDisplay.Count;
            var rows = companiesOrder.Select(c =>
            {
                var companyRows = byCompany.GetValueOrDefault(c) ?? new();
                var employeesCount = companyRows.Count;
                var totalTasks = companyRows.Sum(r => (int)r["total"]!);
                var szch = passedHours > 0 && employeesCount > 0 ? (int)Math.Round((double)totalTasks / employeesCount / passedHours) : 0;
                var byHourOut = new Dictionary<string, int>();
                foreach (var col in hoursDisplay)
                {
                    var colKey = col.ToString();
                    byHourOut[colKey] = companyRows.Sum(r => ((Dictionary<string, object?>)r["byHour"]!).TryGetValue(colKey, out var v) && v is int iv ? iv : 0);
                }
                (decimal Storage, decimal Kdk, decimal Total) w = weightByCompany.TryGetValue(c, out var wv) ? wv : (0, 0, 0);
                (int Storage, int Kdk) sz = szByCompany.TryGetValue(c, out var szv) ? szv : (0, 0);
                var vezch = passedHours > 0 && employeesCount > 0 ? (int)Math.Round((double)w.Total / employeesCount / passedHours) : 0;
                DateTime? firstAtC = null, lastAtC = null;
                foreach (var r in companyRows)
                {
                    var fa = r["firstAt"] as DateTime?;
                    var la = r["lastAt"] as DateTime?;
                    if (fa != null && (firstAtC == null || fa < firstAtC)) firstAtC = fa;
                    if (la != null && (lastAtC == null || la > lastAtC)) lastAtC = la;
                }
                return new Dictionary<string, object?>
                {
                    ["companyName"] = c,
                    ["employeesCount"] = employeesCount,
                    ["szch"] = szch,
                    ["vezch"] = vezch,
                    ["totalTasks"] = totalTasks,
                    ["szStorage"] = sz.Storage,
                    ["szKdk"] = sz.Kdk,
                    ["byHour"] = byHourOut,
                    ["weightStorageGrams"] = w.Storage,
                    ["weightKdkGrams"] = w.Kdk,
                    ["weightTotalGrams"] = w.Total,
                    ["firstAt"] = firstAtC,
                    ["lastAt"] = lastAtC,
                };
            }).ToList();
            companySummary = new { rows, hoursDisplay };
        }

        long idleShiftStartMs = 0, idleShiftEndMs = 0;
        if (!string.IsNullOrEmpty(dateStr) && !string.IsNullOrEmpty(shift))
        {
            var d = DateOnly.Parse(dateStr);
            var todayStr = GetMoscowTodayStr();
            var isToday = dateStr == todayStr;
            if (shift == "day")
            {
                idleShiftStartMs = new DateTimeOffset(d.Year, d.Month, d.Day, 6, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
                idleShiftEndMs = isToday ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : new DateTimeOffset(d.Year, d.Month, d.Day, 18, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
            }
            else
            {
                idleShiftStartMs = new DateTimeOffset(d.Year, d.Month, d.Day, 18, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
                var nextDate = d.AddDays(1);
                var shiftEndFullMs = new DateTimeOffset(nextDate.Year, nextDate.Month, nextDate.Day, 6, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
                var shiftEndDateStr = nextDate.ToString("yyyy-MM-dd");
                idleShiftEndMs = shiftEndDateStr == todayStr ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : shiftEndFullMs;
            }
        }
        var idleThresholdMs = idleThresholdMsOpt is > 0 ? idleThresholdMsOpt.Value : IdleThresholdMsDefault;
        var idlesByEmployee = CalcIdlesByEmployeeSummary(items, idleThresholdMs, idleShiftStartMs, idleShiftEndMs);

        return new DateSummaryResult
        {
            TotalOps = totalOps,
            TotalQty = totalQty,
            Executors = executors,
            Hourly = hourly,
            FirstAt = firstAt,
            LastAt = lastAt,
            CompanySummary = companySummary,
            HourlyByEmployee = hourlyByEmployee,
            IdlesByEmployee = idlesByEmployee,
            TotalWeightStorageGrams = totalWeightStorageGrams,
            TotalWeightKdkGrams = totalWeightKdkGrams,
            TotalWeightGrams = totalWeightStorageGrams + totalWeightKdkGrams,
            WeightByEmployee = weightByEmployee.ToDictionary(kv => kv.Key, kv => new { storage = kv.Value.Storage, kdk = kv.Value.Kdk, total = kv.Value.Total }),
            WeightByCompany = weightByCompany.ToDictionary(kv => kv.Key, kv => new { storage = kv.Value.Storage, kdk = kv.Value.Kdk, total = kv.Value.Total }),
            MissingWeightNames = missingWeightMap.Values.Select(v => v.Name).ToList(),
            MissingWeightItems = missingWeightMap.Values.Select(v => new { name = v.Name, article = v.Article }).ToList(),
        };
    }

    // ─── Смены (аналог getShiftKey/getCurrentShiftKey/listShifts) ──────────────

    private static string GetShiftKeyFromMoscowDateHour(string dateStr, int hour)
    {
        if (hour >= 9 && hour < 21) return $"{dateStr}_day";
        if (hour >= 21) return $"{dateStr}_night";
        var prev = DateOnly.Parse(dateStr).AddDays(-1);
        return $"{prev:yyyy-MM-dd}_night";
    }

    public string GetCurrentShiftKey()
    {
        var m = ToMoscow(DateTime.UtcNow);
        return GetShiftKeyFromMoscowDateHour(m.ToString("yyyy-MM-dd"), m.Hour);
    }

    // Легаси-fallback (data/shift_*.json) не переносим — после бэкфилла
    // Postgres единственный источник для всех дат, старых и новых (см. PLAN.md).
    public async Task<List<WmsOpEntity>> GetShiftItemsAsync(string shiftKey)
    {
        var parts = shiftKey.Split('_');
        if (parts.Length != 2) return new List<WmsOpEntity>();
        var dateStr = parts[0];
        var type = parts[1];
        return await GetDateItemsAsync(dateStr, null, null, type);
    }

    private record ShiftRow(string ShiftKey, string Date, string Type, int Count, DateTime? UpdatedAt, long? FileSize);

    public async Task<List<object>> ListShiftsAsync()
    {
        var raw = await _db.WmsOps.AsNoTracking()
            .GroupBy(o => new { o.Date, o.Hour })
            .Select(g => new { g.Key.Date, g.Key.Hour, Count = g.Count(), LastUpdated = g.Max(o => o.CompletedAt) })
            .ToListAsync();

        var byDate = raw.GroupBy(r => r.Date).ToDictionary(g => g.Key, g => g.ToList());
        var result = new List<ShiftRow>();
        foreach (var (date, rows) in byDate)
        {
            var dayCount = rows.Where(r => r.Hour is >= 9 and < 21).Sum(r => r.Count);
            var nightCount = rows.Where(r => r.Hour >= 21).Sum(r => r.Count);
            var nextDate = date.AddDays(1);
            if (byDate.TryGetValue(nextDate, out var nextRows))
            {
                nightCount += nextRows.Where(r => r.Hour is >= 0 and <= 8).Sum(r => r.Count);
            }
            DateTime? lastUpdated = rows.Where(r => r.LastUpdated != null).Select(r => r.LastUpdated!.Value).DefaultIfEmpty().Max() is var lu && lu != default ? lu : null;
            var dateStr = date.ToString("yyyy-MM-dd");
            if (dayCount > 0) result.Add(new ShiftRow($"{dateStr}_day", dateStr, "day", dayCount, lastUpdated, null));
            if (nightCount > 0) result.Add(new ShiftRow($"{dateStr}_night", dateStr, "night", nightCount, lastUpdated, null));
        }
        return result.OrderByDescending(r => r.ShiftKey, StringComparer.Ordinal)
            .Select(r => (object)new { shiftKey = r.ShiftKey, date = r.Date, type = r.Type, count = r.Count, updatedAt = r.UpdatedAt, fileSize = r.FileSize })
            .ToList();
    }

    // ─── Ops: запись (upsert по merge_key, "первый выигрывает" — как loadHourly) ─
    // Дуал-райт: Node продолжает писать JSON-файлы через tools/SaveFetchedData
    // (для совместимости с ArticleSpeeds/WeightScan/MissingWeightRebuild/
    // EmployeePerformance — читают ТОЛЬКО эти файлы), а /api/save-fetched-data
    // ДОПОЛНИТЕЛЬНО пересылает те же сырые item'ы сюда. Временный мост, см.
    // PLAN.md.

    public async Task<int> IngestOpsAsync(List<System.Text.Json.JsonElement> rawItems)
    {
        // Проход 1 — только распарсить (Date,Hour) каждого элемента (дёшево, без
        // обращений к БД), чтобы заранее собрать все уникальные пары и одним
        // запросом на пару подтянуть уже существующие merge_key. Раньше здесь на
        // КАЖДЫЙ элемент батча уходил отдельный `SELECT EXISTS(...)` — при батче
        // в тысячи операций (обычный размер одной часовой пачки) это давало по
        // несколько секунд ТОЛЬКО на проверку дублей, и совокупно по всем часовым
        // пачкам одного фетча — многие минуты (см. PLAN.md).
        var parsedDates = new (DateOnly Date, short Hour, DateTime CompletedAtUtc)?[rawItems.Count];
        var dateHourPairs = new HashSet<(DateOnly, short)>();
        for (var i = 0; i < rawItems.Count; i++)
        {
            var completedAtStr = GetStr(rawItems[i], "operationCompletedAt");
            if (string.IsNullOrEmpty(completedAtStr)) continue;
            if (!DateTimeOffset.TryParse(completedAtStr, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var completedAtOffset)) continue;
            var completedAtUtc = completedAtOffset.UtcDateTime;
            var moscow = ToMoscow(completedAtUtc);
            var dh = (DateOnly.FromDateTime(moscow), (short)moscow.Hour);
            parsedDates[i] = (dh.Item1, dh.Item2, completedAtUtc);
            dateHourPairs.Add(dh);
        }
        var existingKeysByDateHour = new Dictionary<(DateOnly, short), HashSet<string>>();
        foreach (var (date, hour) in dateHourPairs)
        {
            var keys = await _db.WmsOps.Where(o => o.Date == date && o.Hour == hour).Select(o => o.MergeKey).ToListAsync();
            existingKeysByDateHour[(date, hour)] = new HashSet<string>(keys);
        }

        var added = 0;
        for (var i = 0; i < rawItems.Count; i++)
        {
            var raw = rawItems[i];
            if (parsedDates[i] == null) continue;
            var (date, hourShort, completedAtUtc) = parsedDates[i]!.Value;
            var hour = (int)hourShort;

            var ru = GetObj(raw, "responsibleUser");
            var product = GetObj(raw, "product");
            var executor = ru == null ? "" : string.Join(" ", new[] { GetStr(ru.Value, "lastName"), GetStr(ru.Value, "firstName"), GetStr(ru.Value, "middleName") }
                .Where(s => !string.IsNullOrEmpty(s) && s!.Trim() != "-")).Trim();
            var executorId = ru != null ? (GetStr(ru.Value, "id") ?? "") : "";
            var operationType = GetStr(raw, "operationType") ?? "";
            var type = GetStr(raw, "type") ?? "";
            var nomenclatureCode = product != null ? (GetStr(product.Value, "nomenclatureCode") ?? "") : "";
            var productName = product != null ? (GetStr(product.Value, "name") ?? "") : "";
            var targetAddr = GetObj(raw, "targetAddress");
            var sourceAddr = GetObj(raw, "sourceAddress");
            var cell = (targetAddr != null ? GetStr(targetAddr.Value, "cellAddress") : null)
                ?? (sourceAddr != null ? GetStr(sourceAddr.Value, "cellAddress") : null) ?? "";

            var mergeKey = GetMergeKeyFromLight(operationType, type, executor, cell, nomenclatureCode, productName, GetStr(raw, "id"));

            // `HashSet.Add` возвращает false и для уже существующих в БД ключей
            // (сет засеян ими выше), и для дублей внутри этого же батча — "первый
            // выигрывает", как в loadHourly/merge, без похода в БД на каждый элемент.
            if (!existingKeysByDateHour[(date, (short)hour)].Add(mergeKey)) continue;

            var part = GetObj(raw, "part");
            var sourceQty = GetObj(raw, "sourceQuantity");
            var targetQty = GetObj(raw, "targetQuantity");
            var barcodesArr = product != null && product.Value.TryGetProperty("barcodes", out var barcodesEl) && barcodesEl.ValueKind == System.Text.Json.JsonValueKind.Array
                ? string.Join(", ", barcodesEl.EnumerateArray().Select(b => b.ToString()))
                : "";

            _db.WmsOps.Add(new WmsOpEntity
            {
                Date = date,
                Hour = (short)hour,
                MergeKey = mergeKey,
                ItemId = GetStr(raw, "id") ?? "",
                Type = type,
                OperationType = operationType,
                ProductName = productName,
                NomenclatureCode = nomenclatureCode,
                Barcodes = barcodesArr,
                ProductionDate = part != null ? (GetStr(part.Value, "productionDate") ?? "") : "",
                BestBeforeDate = part != null ? (GetStr(part.Value, "bestBeforeDate") ?? "") : "",
                SourceBarcode = sourceAddr != null ? (GetStr(sourceAddr.Value, "handlingUnitBarcode") ?? "") : "",
                Cell = cell,
                TargetBarcode = targetAddr != null ? (GetStr(targetAddr.Value, "handlingUnitBarcode") ?? "") : "",
                StartedAt = ParseDate(GetStr(raw, "operationStartedAt")),
                CompletedAt = completedAtUtc,
                Executor = executor,
                ExecutorId = executorId,
                SrcOld = GetNum(sourceQty, "oldQuantity"),
                SrcNew = GetNum(sourceQty, "newQuantity"),
                TgtOld = GetNum(targetQty, "oldQuantity"),
                TgtNew = GetNum(targetQty, "newQuantity"),
                Quantity = GetNum(targetQty, "newQuantity") ?? GetNum(sourceQty, "oldQuantity"),
            });
            added++;
        }
        await _db.SaveChangesAsync();
        return added;
    }

    private static string? GetStr(System.Text.Json.JsonElement el, string prop)
        => el.ValueKind == System.Text.Json.JsonValueKind.Object && el.TryGetProperty(prop, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String
            ? v.GetString() : null;

    private static System.Text.Json.JsonElement? GetObj(System.Text.Json.JsonElement el, string prop)
        => el.ValueKind == System.Text.Json.JsonValueKind.Object && el.TryGetProperty(prop, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.Object
            ? v : null;

    private static decimal? GetNum(System.Text.Json.JsonElement? el, string prop)
        => el != null && el.Value.ValueKind == System.Text.Json.JsonValueKind.Object && el.Value.TryGetProperty(prop, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.Number
            ? v.GetDecimal() : null;

    private static DateTime? ParseDate(string? s)
        => !string.IsNullOrEmpty(s) && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d.UtcDateTime : null;

    private static string NormalizePlacementUser(ResponsibleUser u)
    {
        var parts = new[] { u.LastName, u.FirstName, u.MiddleName }.Where(p => !string.IsNullOrEmpty(p));
        return string.Join(" ", parts).Trim();
    }

    private static (DateOnly Date, int Hour)? MoscowDateHour(DateTime? ts)
    {
        if (ts == null) return null;
        var m = ToMoscow(ts.Value);
        return (DateOnly.FromDateTime(m), m.Hour);
    }

    // ─── Placement: запись (мёрдж полей, НЕ "первый выигрывает") ───────────────

    public async Task<(int Added, int Skipped)> SavePlacementItemsAsync(List<System.Text.Json.JsonElement> rawItems)
    {
        int added = 0, skipped = 0;
        // См. комментарий в IngestOpsAsync — та же идея: один запрос на уникальную
        // (Date,Hour) вместо одного `FirstOrDefaultAsync` на КАЖДЫЙ элемент батча
        // (раньше это давало по несколько секунд на часовую пачку в тысячи строк).
        // Заодно закрывает и дедуп внутри батча — второй дубль в том же вызове
        // находит уже добавленную (пусть ещё не закоммиченную) сущность здесь же.
        var dateHourPairs = new HashSet<(DateOnly, short)>();
        foreach (var raw in rawItems)
        {
            var createdAtForSlot = ParseDate(GetStr(raw, "createdAt") ?? GetStr(raw, "completedAt") ?? GetStr(raw, "updatedAt"));
            var slotForPass = MoscowDateHour(createdAtForSlot);
            if (slotForPass != null) dateHourPairs.Add((slotForPass.Value.Date, (short)slotForPass.Value.Hour));
        }
        var batchByKey = new Dictionary<(DateOnly Date, short Hour, string MergeKey), WmsPlacementEntity>();
        foreach (var (date, hour) in dateHourPairs)
        {
            var rows = await _db.WmsPlacement.Where(p => p.Date == date && p.Hour == hour).ToListAsync();
            foreach (var row in rows) batchByKey[(date, hour, row.MergeKey)] = row;
        }

        foreach (var raw in rawItems)
        {
            var ru = GetObj(raw, "responsibleUser");
            var responsibleUser = new ResponsibleUser
            {
                Id = ru != null ? (GetStr(ru.Value, "id") ?? "") : "",
                FirstName = ru != null ? (GetStr(ru.Value, "firstName") ?? "") : "",
                LastName = ru != null ? (GetStr(ru.Value, "lastName") ?? "") : "",
                MiddleName = ru != null ? (GetStr(ru.Value, "middleName") ?? "") : "",
            };
            var createdAt = ParseDate(GetStr(raw, "createdAt") ?? GetStr(raw, "completedAt") ?? GetStr(raw, "updatedAt"));
            if (createdAt == null) continue;
            var slot = MoscowDateHour(createdAt);
            if (slot == null) continue;

            var targetCellsAddresses = new List<string>();
            if (raw.TryGetProperty("targetCellsAddresses", out var tcaEl) && tcaEl.ValueKind == System.Text.Json.JsonValueKind.Array)
                targetCellsAddresses = tcaEl.EnumerateArray().Select(e => e.ToString()).ToList();

            var executorId = responsibleUser.Id;
            var executor = !string.IsNullOrEmpty(NormalizePlacementUser(responsibleUser)) ? NormalizePlacementUser(responsibleUser) : responsibleUser.Id;
            var itemId = (GetStr(raw, "id") ?? "").Trim();
            var handlingUnitBarcode = GetStr(raw, "handlingUnitBarcode") ?? "";
            var targetCellAddress = GetStr(raw, "targetCellAddress") ?? "";
            var skuCount = GetTopNum(raw, "skuCount") ?? 0;

            var mergeKey = itemId != "" ? itemId : (handlingUnitBarcode != "" ? handlingUnitBarcode : $"{createdAt:o}|{executorId}|{targetCellAddress}");
            var key = (slot.Value.Date, (short)slot.Value.Hour, mergeKey);

            var existing = batchByKey.TryGetValue(key, out var batched) ? batched : null;
            if (existing != null)
            {
                existing.Status = GetStr(raw, "status") ?? "";
                existing.HandlingUnitBarcode = handlingUnitBarcode;
                existing.SourceCellAddress = GetStr(raw, "sourceCellAddress") ?? "";
                existing.TargetCellAddress = targetCellAddress;
                existing.TargetCellsAddresses = targetCellsAddresses.Count > 0 ? targetCellsAddresses : existing.TargetCellsAddresses;
                existing.SourceZoneId = GetStr(raw, "sourceZoneId") ?? "";
                existing.SourceZoneName = GetStr(raw, "sourceZoneName") ?? "";
                existing.ResponsibleUser = ru != null ? responsibleUser : existing.ResponsibleUser;
                existing.ExecutorId = executorId != "" ? executorId : existing.ExecutorId;
                existing.Executor = executor != "" ? executor : existing.Executor;
                existing.CreatedAt = createdAt;
                existing.Issue = GetStr(raw, "issue") ?? "";
                existing.Condition = GetStr(raw, "condition") ?? "";
                existing.TemperatureMode = GetStr(raw, "temperatureMode") ?? "";
                existing.SkuCount = skuCount != 0 ? skuCount : existing.SkuCount;
                skipped++;
                continue;
            }

            var newPlacement = new WmsPlacementEntity
            {
                Date = slot.Value.Date,
                Hour = (short)slot.Value.Hour,
                MergeKey = mergeKey,
                ItemId = itemId,
                Status = GetStr(raw, "status") ?? "",
                HandlingUnitBarcode = handlingUnitBarcode,
                SourceCellAddress = GetStr(raw, "sourceCellAddress") ?? "",
                TargetCellAddress = targetCellAddress,
                TargetCellsAddresses = targetCellsAddresses,
                SourceZoneId = GetStr(raw, "sourceZoneId") ?? "",
                SourceZoneName = GetStr(raw, "sourceZoneName") ?? "",
                ResponsibleUser = responsibleUser,
                ExecutorId = executorId,
                Executor = executor,
                CreatedAt = createdAt,
                Issue = GetStr(raw, "issue") ?? "",
                Condition = GetStr(raw, "condition") ?? "",
                TemperatureMode = GetStr(raw, "temperatureMode") ?? "",
                SkuCount = skuCount,
            };
            _db.WmsPlacement.Add(newPlacement);
            batchByKey[key] = newPlacement;
            added++;
        }
        await _db.SaveChangesAsync();
        return (added, skipped);
    }

    private static decimal? GetTopNum(System.Text.Json.JsonElement el, string prop)
        => el.ValueKind == System.Text.Json.JsonValueKind.Object && el.TryGetProperty(prop, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.Number
            ? v.GetDecimal() : null;

    public async Task<List<WmsPlacementEntity>> GetPlacementItemsAsync(string dateStr, int? fromHour, int? toHour, string? shift)
    {
        var date = DateOnly.Parse(dateStr);
        var pairs = GetHoursToLoad(date, fromHour, toHour, shift);
        var dates = pairs.Select(p => p.Date).Distinct().ToList();
        var hours = pairs.Select(p => p.Hour).Distinct().ToList();
        var candidates = await _db.WmsPlacement.AsNoTracking()
            .Where(p => dates.Contains(p.Date) && hours.Contains((int)p.Hour))
            .ToListAsync();
        var pairSet = new HashSet<(DateOnly, int)>(pairs);
        var items = candidates.Where(p => pairSet.Contains((p.Date, (int)p.Hour))).ToList();
        items.Sort((a, b) => string.CompareOrdinal((a.CreatedAt ?? DateTime.MinValue).ToString("o"), (b.CreatedAt ?? DateTime.MinValue).ToString("o")));
        return items;
    }

    public object BuildPlacementSummary(List<WmsPlacementEntity> items, Dictionary<string, string>? idMap)
    {
        var byExecutor = new Dictionary<string, (string Name, string ExecutorId, string Company, Dictionary<string, int> ByHour, HashSet<string> TotalKeys, DateTime? FirstAt, DateTime? LastAt)>();
        var byHour = new Dictionary<int, (int Ops, HashSet<string> Employees)>();
        foreach (var item in items)
        {
            var executorId = item.ExecutorId ?? "";
            var name = !string.IsNullOrEmpty(item.Executor) ? item.Executor : (executorId != "" ? executorId : "—");
            var ts = item.CreatedAt;
            if (ts == null) continue;
            var slot = MoscowDateHour(ts);
            if (slot == null) continue;
            var hour = slot.Value.Hour;
            var taskKey = !string.IsNullOrEmpty(item.ItemId) ? item.ItemId : (!string.IsNullOrEmpty(item.HandlingUnitBarcode) ? item.HandlingUnitBarcode : $"{ts:o}|{executorId}|{item.TargetCellAddress}");
            var dictKey = executorId != "" ? executorId : name;
            if (!byExecutor.TryGetValue(dictKey, out var rec))
            {
                rec = (name, executorId, idMap != null ? (ResolveCompany(idMap, executorId) ?? "—") : "—", new Dictionary<string, int>(), new HashSet<string>(), null, null);
            }
            rec.TotalKeys.Add(taskKey);
            rec.ByHour[hour.ToString()] = rec.ByHour.GetValueOrDefault(hour.ToString()) + 1;
            if (rec.FirstAt == null || ts < rec.FirstAt) rec.FirstAt = ts;
            if (rec.LastAt == null || ts > rec.LastAt) rec.LastAt = ts;
            byExecutor[dictKey] = rec;

            if (!byHour.TryGetValue(hour, out var hh)) hh = (0, new HashSet<string>());
            hh.Ops += 1;
            if (dictKey != "") hh.Employees.Add(dictKey);
            byHour[hour] = hh;
        }
        var rows = byExecutor.Values.Select(r => new
        {
            name = r.Name,
            executorId = r.ExecutorId != "" ? r.ExecutorId : null,
            company = r.Company,
            byHour = r.ByHour,
            byHourZone = new Dictionary<string, object?>(),
            byZone = new Dictionary<string, object?>(),
            weightByHour = new Dictionary<string, object?>(),
            total = r.TotalKeys.Count,
            firstAt = r.FirstAt,
            lastAt = r.LastAt,
        }).OrderByDescending(r => r.total).ThenBy(r => r.name, StringComparer.Create(new CultureInfo("ru-RU"), false)).ToList();
        var hoursList = rows.SelectMany(r => r.byHour.Keys.Select(int.Parse)).Distinct().OrderBy(h => h).ToList();
        var hourly = byHour.Select(kv => new
        {
            hour = kv.Key,
            ops = kv.Value.Ops,
            employees = kv.Value.Employees.Count,
            storageOps = kv.Value.Ops,
            kdkOps = 0,
            storageEmployees = kv.Value.Employees.Count,
            kdkEmployees = 0,
        }).OrderBy(h => h.hour).ToList();
        return new
        {
            totalOps = rows.Sum(r => r.total),
            executors = rows.Select(r => new { name = r.name, executorId = r.executorId, ops = r.total, firstAt = r.firstAt, lastAt = r.lastAt }).ToList(),
            hourly,
            hourlyByEmployee = new { hours = hoursList, rows },
        };
    }

    public async Task<object> GetPlacementSummaryAsync(string dateStr, int? fromHour, int? toHour, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var items = await GetPlacementItemsAsync(dateStr, fromHour, toHour, shift);
        if (!string.IsNullOrEmpty(filterExecutorNorm))
            items = items.Where(it => NormalizeFioSummary(it.Executor) == filterExecutorNorm).ToList();
        if (filterCompanies != null && filterCompanies.Count > 0 && idMap != null)
        {
            var allowed = new HashSet<string>(filterCompanies.Select(c => c.Trim().ToLowerInvariant()));
            items = items.Where(it =>
            {
                var company = ResolveCompany(idMap, it.ExecutorId);
                return !string.IsNullOrEmpty(company) && allowed.Contains(company.Trim().ToLowerInvariant());
            }).ToList();
        }
        return BuildPlacementSummary(items, idMap);
    }

    // ─── Receiving: запись (мёрдж, отдельный "secondary" счётчик eoCount) ──────

    public async Task<(int Added, int Skipped)> SaveReceivingItemsAsync(List<System.Text.Json.JsonElement> rawItems)
    {
        int added = 0, skipped = 0;
        // См. комментарий в IngestOpsAsync/SavePlacementItemsAsync — один запрос
        // на уникальную (Date,Hour) вместо запроса на каждый элемент батча.
        var dateHourPairs = new HashSet<(DateOnly, short)>();
        foreach (var raw in rawItems)
        {
            var completedAtForSlot = ParseDate(GetStr(raw, "completedAt") ?? GetStr(raw, "createdAt") ?? GetStr(raw, "updatedAt"));
            var slotForPass = MoscowDateHour(completedAtForSlot);
            if (slotForPass != null) dateHourPairs.Add((slotForPass.Value.Date, (short)slotForPass.Value.Hour));
        }
        var batchByKey = new Dictionary<(DateOnly Date, short Hour, string MergeKey), WmsReceivingEntity>();
        foreach (var (date, hour) in dateHourPairs)
        {
            var rows = await _db.WmsReceiving.Where(r => r.Date == date && r.Hour == hour).ToListAsync();
            foreach (var row in rows) batchByKey[(date, hour, row.MergeKey)] = row;
        }

        foreach (var raw in rawItems)
        {
            var ru = GetObj(raw, "responsibleUser") ?? GetObj(raw, "acceptedBy");
            var responsibleUser = new ResponsibleUser
            {
                Id = ru != null ? (GetStr(ru.Value, "id") ?? "") : "",
                FirstName = ru != null ? (GetStr(ru.Value, "firstName") ?? "") : "",
                LastName = ru != null ? (GetStr(ru.Value, "lastName") ?? "") : "",
                MiddleName = ru != null ? (GetStr(ru.Value, "middleName") ?? "") : "",
            };
            var completedAt = ParseDate(GetStr(raw, "completedAt") ?? GetStr(raw, "createdAt") ?? GetStr(raw, "updatedAt"));
            if (completedAt == null) continue;
            var slot = MoscowDateHour(completedAt);
            if (slot == null) continue;

            var executorId = responsibleUser.Id;
            var executor = !string.IsNullOrEmpty(NormalizePlacementUser(responsibleUser)) ? NormalizePlacementUser(responsibleUser) : responsibleUser.Id;
            var itemId = (GetStr(raw, "id") ?? "").Trim();
            var taskNumber = GetStr(raw, "taskNumber") ?? GetStr(raw, "number") ?? "";
            var supplierObj = GetObj(raw, "supplier");
            var supplierName = (supplierObj != null ? GetStr(supplierObj.Value, "name") : null) ?? GetStr(raw, "supplierName") ?? "";
            var eoCount = GetTopNum(raw, "handlingUnitsQuantity") ?? GetTopNum(raw, "eoCount") ?? 0;

            var mergeKey = itemId != "" ? itemId : $"{completedAt:o}|{executorId}|{taskNumber}";
            var key = (slot.Value.Date, (short)slot.Value.Hour, mergeKey);

            var existing = batchByKey.TryGetValue(key, out var batched) ? batched : null;
            if (existing != null)
            {
                existing.Status = GetStr(raw, "status") ?? "";
                existing.Type = GetStr(raw, "type") ?? GetStr(raw, "taskType") ?? "";
                existing.TaskNumber = taskNumber;
                existing.OrderNumber = GetStr(raw, "orderNumber") ?? "";
                existing.SupplierName = supplierName;
                existing.StartedAt = ParseDate(GetStr(raw, "startedAt") ?? GetStr(raw, "acceptanceStartedAt"));
                existing.ResponsibleUser = ru != null ? responsibleUser : existing.ResponsibleUser;
                existing.ExecutorId = executorId != "" ? executorId : existing.ExecutorId;
                existing.Executor = executor != "" ? executor : existing.Executor;
                existing.CompletedAt = completedAt;
                existing.VolumeInMilliliters = GetTopNum(raw, "volumeInMilliliters") ?? existing.VolumeInMilliliters;
                existing.WeightInGrams = GetTopNum(raw, "weightInGrams") ?? GetTopNum(raw, "actualWeightInGrams") ?? existing.WeightInGrams;
                existing.EoCount = eoCount != 0 ? eoCount : existing.EoCount;
                skipped++;
                continue;
            }

            var newReceiving = new WmsReceivingEntity
            {
                Date = slot.Value.Date,
                Hour = (short)slot.Value.Hour,
                MergeKey = mergeKey,
                ItemId = itemId,
                Status = GetStr(raw, "status") ?? "",
                Type = GetStr(raw, "type") ?? GetStr(raw, "taskType") ?? "",
                TaskNumber = taskNumber,
                OrderNumber = GetStr(raw, "orderNumber") ?? "",
                SupplierName = supplierName,
                StartedAt = ParseDate(GetStr(raw, "startedAt") ?? GetStr(raw, "acceptanceStartedAt")),
                ResponsibleUser = responsibleUser,
                ExecutorId = executorId,
                Executor = executor,
                CompletedAt = completedAt,
                VolumeInMilliliters = GetTopNum(raw, "volumeInMilliliters") ?? 0,
                WeightInGrams = GetTopNum(raw, "weightInGrams") ?? GetTopNum(raw, "actualWeightInGrams") ?? 0,
                EoCount = eoCount,
            };
            _db.WmsReceiving.Add(newReceiving);
            batchByKey[key] = newReceiving;
            added++;
        }
        await _db.SaveChangesAsync();
        return (added, skipped);
    }

    public async Task<List<WmsReceivingEntity>> GetReceivingItemsAsync(string dateStr, int? fromHour, int? toHour, string? shift)
    {
        var date = DateOnly.Parse(dateStr);
        var pairs = GetHoursToLoad(date, fromHour, toHour, shift);
        var dates = pairs.Select(p => p.Date).Distinct().ToList();
        var hours = pairs.Select(p => p.Hour).Distinct().ToList();
        var candidates = await _db.WmsReceiving.AsNoTracking()
            .Where(r => dates.Contains(r.Date) && hours.Contains((int)r.Hour))
            .ToListAsync();
        var pairSet = new HashSet<(DateOnly, int)>(pairs);
        var items = candidates.Where(r => pairSet.Contains((r.Date, (int)r.Hour))).ToList();
        items.Sort((a, b) => string.CompareOrdinal((a.CompletedAt ?? DateTime.MinValue).ToString("o"), (b.CompletedAt ?? DateTime.MinValue).ToString("o")));
        return items;
    }

    public object BuildReceivingSummary(List<WmsReceivingEntity> items, Dictionary<string, string>? idMap)
    {
        var byExecutor = new Dictionary<string, (string Name, string ExecutorId, string Company, Dictionary<string, int> ByHour, Dictionary<string, decimal> SecondaryByHour, HashSet<string> TotalKeys, decimal SecondaryTotal, DateTime? FirstAt, DateTime? LastAt)>();
        var byHour = new Dictionary<int, (int Ops, decimal Secondary, HashSet<string> Employees)>();
        foreach (var item in items)
        {
            var executorId = item.ExecutorId ?? "";
            var name = !string.IsNullOrEmpty(item.Executor) ? item.Executor : (executorId != "" ? executorId : "—");
            var ts = item.CompletedAt;
            if (ts == null) continue;
            var slot = MoscowDateHour(ts);
            if (slot == null) continue;
            var hour = slot.Value.Hour;
            var taskKey = !string.IsNullOrEmpty(item.ItemId) ? item.ItemId : $"{ts:o}|{executorId}|{item.TaskNumber}";
            var eoCount = item.EoCount;
            var dictKey = executorId != "" ? executorId : name;
            if (!byExecutor.TryGetValue(dictKey, out var rec))
            {
                rec = (name, executorId, idMap != null ? (ResolveCompany(idMap, executorId) ?? "—") : "—", new Dictionary<string, int>(), new Dictionary<string, decimal>(), new HashSet<string>(), 0, null, null);
            }
            rec.TotalKeys.Add(taskKey);
            rec.ByHour[hour.ToString()] = rec.ByHour.GetValueOrDefault(hour.ToString()) + 1;
            rec.SecondaryByHour[hour.ToString()] = rec.SecondaryByHour.GetValueOrDefault(hour.ToString()) + eoCount;
            rec.SecondaryTotal += eoCount;
            if (rec.FirstAt == null || ts < rec.FirstAt) rec.FirstAt = ts;
            if (rec.LastAt == null || ts > rec.LastAt) rec.LastAt = ts;
            byExecutor[dictKey] = rec;

            if (!byHour.TryGetValue(hour, out var hh)) hh = (0, 0, new HashSet<string>());
            hh.Ops += 1;
            hh.Secondary += eoCount;
            if (dictKey != "") hh.Employees.Add(dictKey);
            byHour[hour] = hh;
        }
        var rows = byExecutor.Values.Select(r => new
        {
            name = r.Name,
            executorId = r.ExecutorId != "" ? r.ExecutorId : null,
            company = r.Company,
            byHour = r.ByHour,
            secondaryByHour = r.SecondaryByHour,
            secondaryTotal = r.SecondaryTotal,
            byHourZone = new Dictionary<string, object?>(),
            byZone = new Dictionary<string, object?>(),
            weightByHour = new Dictionary<string, object?>(),
            total = r.TotalKeys.Count,
            firstAt = r.FirstAt,
            lastAt = r.LastAt,
        }).OrderByDescending(r => r.total).ThenBy(r => r.name, StringComparer.Create(new CultureInfo("ru-RU"), false)).ToList();
        var hoursList = rows.SelectMany(r => r.byHour.Keys.Select(int.Parse)).Distinct().OrderBy(h => h).ToList();
        var hourly = byHour.Select(kv => new
        {
            hour = kv.Key,
            ops = kv.Value.Ops,
            secondary = kv.Value.Secondary,
            employees = kv.Value.Employees.Count,
            storageOps = kv.Value.Ops,
            kdkOps = 0,
            storageEmployees = kv.Value.Employees.Count,
            kdkEmployees = 0,
        }).OrderBy(h => h.hour).ToList();
        return new
        {
            totalOps = rows.Sum(r => r.total),
            totalSecondary = rows.Sum(r => r.secondaryTotal),
            executors = rows.Select(r => new { name = r.name, executorId = r.executorId, ops = r.total, secondary = r.secondaryTotal, firstAt = r.firstAt, lastAt = r.lastAt }).ToList(),
            hourly,
            hourlyByEmployee = new { hours = hoursList, rows },
        };
    }

    public async Task<object> GetReceivingSummaryAsync(string dateStr, int? fromHour, int? toHour, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var items = await GetReceivingItemsAsync(dateStr, fromHour, toHour, shift);
        if (!string.IsNullOrEmpty(filterExecutorNorm))
            items = items.Where(it => NormalizeFioSummary(it.Executor) == filterExecutorNorm).ToList();
        if (filterCompanies != null && filterCompanies.Count > 0 && idMap != null)
        {
            var allowed = new HashSet<string>(filterCompanies.Select(c => c.Trim().ToLowerInvariant()));
            items = items.Where(it =>
            {
                var company = ResolveCompany(idMap, it.ExecutorId);
                return !string.IsNullOrEmpty(company) && allowed.Contains(company.Trim().ToLowerInvariant());
            }).ToList();
        }
        return BuildReceivingSummary(items, idMap);
    }

    // ─── Remains: запись ─────────────────────────────────────────────────────
    // Саммари remains ПЕРЕИСПОЛЬЗУЕТ BuildPlacementSummary — как и в оригинале
    // (storage.js:1335-1348, getRemainsSummary вызывает buildPlacementSummary,
    // а не отдельную buildRemainsSummary) — повторено здесь намеренно, 1-в-1.

    public async Task<(int Added, int Skipped)> SaveRemainsItemsAsync(List<System.Text.Json.JsonElement> rawItems)
    {
        int added = 0, skipped = 0;
        // См. комментарий в IngestOpsAsync/SavePlacementItemsAsync — один запрос
        // на уникальную (Date,Hour) вместо запроса на каждый элемент батча.
        var dateHourPairs = new HashSet<(DateOnly, short)>();
        foreach (var raw in rawItems)
        {
            var createdAtForSlot = ParseDate(GetStr(raw, "createdAt") ?? GetStr(raw, "completedAt") ?? GetStr(raw, "updatedAt"));
            var slotForPass = MoscowDateHour(createdAtForSlot);
            if (slotForPass != null) dateHourPairs.Add((slotForPass.Value.Date, (short)slotForPass.Value.Hour));
        }
        var batchByKey = new Dictionary<(DateOnly Date, short Hour, string MergeKey), WmsRemainsEntity>();
        foreach (var (date, hour) in dateHourPairs)
        {
            var rows = await _db.WmsRemains.Where(r => r.Date == date && r.Hour == hour).ToListAsync();
            foreach (var row in rows) batchByKey[(date, hour, row.MergeKey)] = row;
        }

        foreach (var raw in rawItems)
        {
            var ru = GetObj(raw, "responsibleUser");
            var responsibleUser = new ResponsibleUser
            {
                Id = ru != null ? (GetStr(ru.Value, "id") ?? "") : "",
                FirstName = ru != null ? (GetStr(ru.Value, "firstName") ?? "") : "",
                LastName = ru != null ? (GetStr(ru.Value, "lastName") ?? "") : "",
                MiddleName = ru != null ? (GetStr(ru.Value, "middleName") ?? "") : "",
            };
            var createdAt = ParseDate(GetStr(raw, "createdAt") ?? GetStr(raw, "completedAt") ?? GetStr(raw, "updatedAt"));
            if (createdAt == null) continue;
            var slot = MoscowDateHour(createdAt);
            if (slot == null) continue;

            var executorId = responsibleUser.Id;
            var executor = !string.IsNullOrEmpty(NormalizePlacementUser(responsibleUser)) ? NormalizePlacementUser(responsibleUser) : responsibleUser.Id;
            var itemId = (GetStr(raw, "id") ?? "").Trim();
            var sourceHu = GetStr(raw, "sourceHandlingUnitBarcode") ?? "";
            var targetHu = GetStr(raw, "targetHandlingUnitBarcode") ?? "";
            var consolidationItems = new List<System.Text.Json.JsonElement>();
            if (raw.TryGetProperty("consolidationItems", out var ciEl) && ciEl.ValueKind == System.Text.Json.JsonValueKind.Array)
                consolidationItems = ciEl.EnumerateArray().ToList();

            var mergeKey = itemId != "" ? itemId : $"{createdAt:o}|{executorId}|{sourceHu}|{targetHu}";
            var key = (slot.Value.Date, (short)slot.Value.Hour, mergeKey);

            var existing = batchByKey.TryGetValue(key, out var batched) ? batched : null;
            if (existing != null)
            {
                existing.Status = GetStr(raw, "status") ?? "";
                existing.TaskType = GetStr(raw, "taskType") ?? "";
                existing.SourceCellAddress = GetStr(raw, "sourceCellAddress") ?? "";
                existing.SourceHandlingUnitBarcode = sourceHu;
                existing.TargetCellAddress = GetStr(raw, "targetCellAddress") ?? "";
                existing.TargetHandlingUnitBarcode = targetHu;
                existing.ConsolidationItems = consolidationItems.Count > 0 ? consolidationItems : existing.ConsolidationItems;
                existing.ResponsibleUser = ru != null ? responsibleUser : existing.ResponsibleUser;
                existing.ExecutorId = executorId != "" ? executorId : existing.ExecutorId;
                existing.Executor = executor != "" ? executor : existing.Executor;
                existing.CreatedAt = createdAt;
                skipped++;
                continue;
            }

            var newRemains = new WmsRemainsEntity
            {
                Date = slot.Value.Date,
                Hour = (short)slot.Value.Hour,
                MergeKey = mergeKey,
                ItemId = itemId,
                Status = GetStr(raw, "status") ?? "",
                TaskType = GetStr(raw, "taskType") ?? "",
                SourceCellAddress = GetStr(raw, "sourceCellAddress") ?? "",
                SourceHandlingUnitBarcode = sourceHu,
                TargetCellAddress = GetStr(raw, "targetCellAddress") ?? "",
                TargetHandlingUnitBarcode = targetHu,
                ConsolidationItems = consolidationItems,
                ResponsibleUser = responsibleUser,
                ExecutorId = executorId,
                Executor = executor,
                CreatedAt = createdAt,
            };
            _db.WmsRemains.Add(newRemains);
            batchByKey[key] = newRemains;
            added++;
        }
        await _db.SaveChangesAsync();
        return (added, skipped);
    }

    public async Task<List<WmsRemainsEntity>> GetRemainsItemsAsync(string dateStr, int? fromHour, int? toHour, string? shift)
    {
        var date = DateOnly.Parse(dateStr);
        var pairs = GetHoursToLoad(date, fromHour, toHour, shift);
        var dates = pairs.Select(p => p.Date).Distinct().ToList();
        var hours = pairs.Select(p => p.Hour).Distinct().ToList();
        var candidates = await _db.WmsRemains.AsNoTracking()
            .Where(r => dates.Contains(r.Date) && hours.Contains((int)r.Hour))
            .ToListAsync();
        var pairSet = new HashSet<(DateOnly, int)>(pairs);
        var items = candidates.Where(r => pairSet.Contains((r.Date, (int)r.Hour))).ToList();
        items.Sort((a, b) => string.CompareOrdinal((a.CreatedAt ?? DateTime.MinValue).ToString("o"), (b.CreatedAt ?? DateTime.MinValue).ToString("o")));
        return items;
    }

    // Remains-эквивалент WmsPlacementEntity для переиспользования BuildPlacementSummary.
    private static WmsPlacementEntity RemainsAsPlacement(WmsRemainsEntity r) => new()
    {
        ItemId = r.ItemId,
        HandlingUnitBarcode = "",
        TargetCellAddress = r.TargetCellAddress,
        Executor = r.Executor,
        ExecutorId = r.ExecutorId,
        CreatedAt = r.CreatedAt,
    };

    public async Task<object> GetRemainsSummaryAsync(string dateStr, int? fromHour, int? toHour, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var items = await GetRemainsItemsAsync(dateStr, fromHour, toHour, shift);
        var asPlacement = items.Select(RemainsAsPlacement).ToList();
        if (!string.IsNullOrEmpty(filterExecutorNorm))
            asPlacement = asPlacement.Where(it => NormalizeFioSummary(it.Executor) == filterExecutorNorm).ToList();
        if (filterCompanies != null && filterCompanies.Count > 0 && idMap != null)
        {
            var allowed = new HashSet<string>(filterCompanies.Select(c => c.Trim().ToLowerInvariant()));
            asPlacement = asPlacement.Where(it =>
            {
                var company = ResolveCompany(idMap, it.ExecutorId);
                return !string.IsNullOrEmpty(company) && allowed.Contains(company.Trim().ToLowerInvariant());
            }).ToList();
        }
        return BuildPlacementSummary(asPlacement, idMap);
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

    // ─── /api/analysis/employee-rates ──────────────────────────────────────────

    public async Task<object> GetEmployeeRatesAsync(string dateFrom, string dateTo, string? shift, long idleThresholdMs, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var dates = GetDateRangeList(dateFrom, dateTo);
        var totals = new Dictionary<string, (decimal TasksCount, int HoursWorked, decimal PeakPerHour, Dictionary<string, (decimal Count, decimal WeightGrams)> ByZone)>();

        foreach (var dateStr in dates)
        {
            var summary = await GetDateSummaryAsync(dateStr, shift, idleThresholdMs, filterExecutorNorm, filterCompanies, idMap);
            var hb = summary.HourlyByEmployee;
            foreach (var row in hb.Rows)
            {
                var name = row.GetValueOrDefault("name") as string ?? "";
                if (string.IsNullOrEmpty(name)) continue;
                var byHour = row.GetValueOrDefault("byHour") as Dictionary<string, object?> ?? new();
                var hoursWorked = 0;
                decimal peakPerHour = 0;
                foreach (var h in hb.Hours)
                {
                    var v = byHour.GetValueOrDefault(h.ToString()) is int iv ? iv : 0;
                    if (v > 0) hoursWorked++;
                    if (v > peakPerHour) peakPerHour = v;
                }
                if (!totals.TryGetValue(name, out var t)) t = (0, 0, 0, new Dictionary<string, (decimal, decimal)>());
                t.TasksCount += row.GetValueOrDefault("total") is int totalVal ? totalVal : 0;
                t.HoursWorked += hoursWorked;
                if (peakPerHour > t.PeakPerHour) t.PeakPerHour = peakPerHour;
                if (row.GetValueOrDefault("byZone") is Dictionary<string, object?> byZone)
                {
                    foreach (var (zk, zv) in byZone)
                    {
                        if (zv is not Dictionary<string, object?> zvd) continue;
                        (decimal Count, decimal WeightGrams) zEntry = t.ByZone.TryGetValue(zk, out var ze) ? ze : (0, 0);
                        zEntry.Count += zvd.GetValueOrDefault("count") is int cv ? cv : 0;
                        zEntry.WeightGrams += zvd.GetValueOrDefault("weightGrams") is decimal wv ? wv : 0;
                        t.ByZone[zk] = zEntry;
                    }
                }
                totals[name] = t;
            }
        }

        var list = totals.Select(kv =>
        {
            var (name, t) = (kv.Key, kv.Value);
            var hours = t.HoursWorked;
            var szPerHour = hours > 0 ? t.TasksCount / hours : 0;
            var totalWeightGrams = t.ByZone.Values.Sum(z => z.WeightGrams);
            var kgPerHour = hours > 0 ? (totalWeightGrams / 1000) / hours : 0;
            var kgPerHourByZone = t.ByZone.ToDictionary(z => z.Key, z => hours > 0 ? Math.Round(z.Value.WeightGrams / 1000 / hours, 2) : 0);
            return new
            {
                name,
                tasksCount = t.TasksCount,
                hoursWorked = (int)Math.Round((double)hours),
                szPerHour = Math.Round(szPerHour, 2),
                peakPerHour = Math.Round(t.PeakPerHour, 2),
                kgPerHour = Math.Round(kgPerHour, 2),
                kgPerHourByZone,
                byZone = t.ByZone.ToDictionary(z => z.Key, z => new { count = z.Value.Count, weightGrams = z.Value.WeightGrams }),
            };
        }).OrderByDescending(e => e.szPerHour).ThenByDescending(e => e.tasksCount).ThenBy(e => e.name, StringComparer.Create(new CultureInfo("ru-RU"), false)).ToList();

        return new { dateFrom, dateTo, shift = shift ?? (object?)null, count = list.Count, employees = list };
    }

    // ─── /api/stats/monthly-company (аналог computeCompanyDay + цикл по дням) ──

    public async Task<object> GetMonthlyCompanyAsync(int year, int month, string? shift, Dictionary<string, string>? idMap)
    {
        var daysInMonth = DateTime.DaysInMonth(year, month);
        var weightMap = await GetWeightMapAsync();
        var monthly = new Dictionary<string, (int TotalTasks, int StorageOps, int KdkOps, int PalletOps, decimal WeightStorageGrams, decimal WeightKdkGrams, HashSet<string> Employees, int WorkDays)>();

        for (var day = 1; day <= daysInMonth; day++)
        {
            var dateStr = $"{year}-{month:D2}-{day:D2}";
            var items = await GetDateItemsAsync(dateStr, null, null, shift);
            if (items.Count == 0) continue;

            var dayByCompany = new Dictionary<string, (HashSet<string> TaskKeys, int StorageOps, int KdkOps, int PalletOps, decimal WeightStorageGrams, decimal WeightKdkGrams, HashSet<string> Employees)>();
            foreach (var item in items)
            {
                var op = (item.OperationType ?? "").ToUpperInvariant();
                var isKdk = op == "PICK_BY_LINE";
                var isPallet = op == "PALLET_SELECTION_MOVE_TO_PICK_BY_LINE";
                var isStorage = op == "PIECE_SELECTION_PICKING";
                if (!isKdk && !isPallet && !isStorage) continue;

                var company = ResolveCompany(idMap, item.ExecutorId) ?? "—";
                var taskKey = isKdk
                    ? $"task|{item.Executor ?? ""}|{item.Cell ?? ""}|{(!string.IsNullOrEmpty(item.NomenclatureCode) ? item.NomenclatureCode : item.ProductName) ?? ""}"
                    : $"id|{item.ItemId ?? ""}";

                if (!dayByCompany.TryGetValue(company, out var dc))
                    dc = (new HashSet<string>(), 0, 0, 0, 0, 0, new HashSet<string>());
                if (!dc.TaskKeys.Contains(taskKey))
                {
                    dc.TaskKeys.Add(taskKey);
                    if (isKdk) dc.KdkOps++; else if (isPallet) dc.PalletOps++; else dc.StorageOps++;
                }
                var grams = GetWeightGrams(weightMap, item.NomenclatureCode) * Math.Max(1, item.Quantity ?? 1);
                if (grams > 0) { if (isKdk) dc.WeightKdkGrams += grams; else dc.WeightStorageGrams += grams; }
                dc.Employees.Add(NormalizeFioSummary(item.Executor));
                dayByCompany[company] = dc;
            }

            foreach (var (company, dc) in dayByCompany)
            {
                if (!monthly.TryGetValue(company, out var r))
                    r = (0, 0, 0, 0, 0, 0, new HashSet<string>(), 0);
                r.TotalTasks += dc.TaskKeys.Count;
                r.StorageOps += dc.StorageOps;
                r.KdkOps += dc.KdkOps;
                r.PalletOps += dc.PalletOps;
                r.WeightStorageGrams += dc.WeightStorageGrams;
                r.WeightKdkGrams += dc.WeightKdkGrams;
                foreach (var e in dc.Employees) r.Employees.Add(e);
                r.WorkDays++;
                monthly[company] = r;
            }
        }

        var companies = monthly.Select(kv => new
        {
            name = kv.Key,
            totalTasks = kv.Value.TotalTasks,
            storageOps = kv.Value.StorageOps,
            kdkOps = kv.Value.KdkOps,
            palletOps = kv.Value.PalletOps,
            weightStorageGrams = kv.Value.WeightStorageGrams,
            weightKdkGrams = kv.Value.WeightKdkGrams,
            weightTotalGrams = kv.Value.WeightStorageGrams + kv.Value.WeightKdkGrams,
            employees = kv.Value.Employees.Count,
            workDays = kv.Value.WorkDays,
        }).OrderByDescending(c => c.totalTasks).ToList();

        return new { year, month, daysInMonth, companies };
    }

    // ─── /api/stats/monthly-employees ───────────────────────────────────────────
    // ВАЖНО: оригинал (server.js) считает час через new Date(ts).getHours() —
    // локальное время процесса Node (НЕ московский сдвиг, в отличие от
    // buildSummaryFromItems). Контейнер node запускается в UTC, поэтому здесь
    // намеренно используется ts.Hour (UTC-час DateTime), а не ToMoscow(ts) —
    // faithful port особенности оригинала, а не самостоятельный выбор.

    private record MonthlyEmployeeRow(string Date, string Name, string ExecutorId, int Total, double WorkedMinutes, string Company);

    public async Task<object> GetMonthlyEmployeesAsync(string dateFrom, string dateTo, string? shift, string zoneFilter, Dictionary<string, string>? idMap)
    {
        const long idleThresholdMsLocal = 5 * 60 * 1000;
        var dates = GetDateRangeList(dateFrom, dateTo);
        var allRows = new List<MonthlyEmployeeRow>();

        foreach (var dateStr in dates)
        {
            var items = await GetDateItemsAsync(dateStr, null, null, shift);
            var dayMap = new Dictionary<string, (string Name, string ExecutorId, Dictionary<int, HashSet<string>> HourMap, int StorageCount, List<long> Timestamps)>();

            foreach (var item in items)
            {
                var opType = (item.OperationType ?? "").ToUpperInvariant();
                var isKdk = opType == "PICK_BY_LINE";
                var isStorage = opType == "PIECE_SELECTION_PICKING";
                if (!isKdk && !isStorage) continue;

                if (!string.IsNullOrEmpty(zoneFilter))
                {
                    var cellVal = item.Cell ?? "";
                    var dash = cellVal.IndexOf('-');
                    var zk = dash > 0 ? cellVal[..dash].ToUpperInvariant() : cellVal.ToUpperInvariant();
                    if (zk != zoneFilter) continue;
                }

                var executor = (item.Executor ?? "").Trim();
                if (executor == "") executor = "Неизвестно";
                var executorId = item.ExecutorId ?? "";
                var normKey = System.Text.RegularExpressions.Regex.Replace(executor, @"\s+", " ").ToLowerInvariant();

                if (!dayMap.TryGetValue(normKey, out var emp))
                    emp = (executor, executorId, new Dictionary<int, HashSet<string>>(), 0, new List<long>());
                if (emp.ExecutorId == "" && executorId != "") emp.ExecutorId = executorId;

                var ts = item.CompletedAt;
                var col = ts.HasValue ? (ts.Value.Hour + 1) % 24 : -1;
                if (ts.HasValue) emp.Timestamps.Add(new DateTimeOffset(DateTime.SpecifyKind(ts.Value, DateTimeKind.Utc)).ToUnixTimeMilliseconds());

                if (isStorage)
                {
                    emp.StorageCount++;
                }
                else
                {
                    var product = !string.IsNullOrEmpty(item.NomenclatureCode) ? item.NomenclatureCode : (item.ProductName ?? "");
                    var cellVal = item.Cell ?? "";
                    if (!emp.HourMap.TryGetValue(col, out var set)) { set = new HashSet<string>(); emp.HourMap[col] = set; }
                    set.Add($"{product}||{cellVal}");
                }
                dayMap[normKey] = emp;
            }

            foreach (var emp in dayMap.Values)
            {
                var kdkCount = emp.HourMap.Values.Sum(s => s.Count);
                var total = kdkCount + emp.StorageCount;
                if (total == 0) continue;

                double workedMinutes = 0;
                if (emp.Timestamps.Count > 1)
                {
                    var times = emp.Timestamps.OrderBy(t => t).ToList();
                    long idleMs = 0;
                    for (var i = 1; i < times.Count; i++)
                    {
                        var gap = times[i] - times[i - 1];
                        if (gap >= idleThresholdMsLocal) idleMs += gap;
                    }
                    workedMinutes = Math.Max(0, (times[^1] - times[0]) - idleMs) / 60000.0;
                }

                allRows.Add(new MonthlyEmployeeRow(
                    dateStr,
                    emp.Name,
                    emp.ExecutorId,
                    total,
                    Math.Round(workedMinutes * 10) / 10,
                    ResolveCompany(idMap, emp.ExecutorId) ?? "—"));
            }
        }

        var sorted = allRows.OrderBy(r => r.Date, StringComparer.Ordinal).ThenByDescending(r => r.Total)
            .Select(r => new { date = r.Date, name = r.Name, executorId = r.ExecutorId, total = r.Total, workedMinutes = r.WorkedMinutes, company = r.Company })
            .ToList();

        return new { ok = true, dateFrom, dateTo, zone = zoneFilter, count = sorted.Count, rows = sorted };
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
