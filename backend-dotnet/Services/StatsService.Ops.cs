using System.Globalization;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Комплектация и прочие операции (wms_ops): чтение за день, главная сводка статистики, простои, смены, запись выгрузки.
public partial class StatsService
{
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
            // Задачи по зонам — тем же счётом, что и «Итого» (штучный отбор — по
            // строке, раскладка КДК — уникальная пара товар+ячейка за час), чтобы
            // сумма по зонам сходилась с итогом сотрудника. ZoneCounts выше — по
            // строкам (для доминирующей зоны часа), для итогов не годится.
            var zoneTasksByEmp = new Dictionary<string, Dictionary<(int Col, string Zone), (int Pieces, HashSet<string> Kdk)>>();
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
                    if (zoneKey != "")
                    {
                        if (!zoneTasksByEmp.TryGetValue(executorId, out var zt)) zoneTasksByEmp[executorId] = zt = new();
                        var zk2 = (col, zoneKey);
                        var e = zt.TryGetValue(zk2, out var ex) ? ex : (0, new HashSet<string>());
                        if (type == "PIECE_SELECTION_PICKING") e.Item1++;
                        else e.Item2.Add($"{(!string.IsNullOrEmpty(item.NomenclatureCode) ? item.NomenclatureCode : (!string.IsNullOrEmpty(item.ProductName) ? item.ProductName : "no-product"))}||{(!string.IsNullOrEmpty(item.Cell) ? item.Cell : "no-target-cell")}");
                        zt[zk2] = e;
                    }
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
                // задачи по зонам за часы смены (order) — как total
                var zoneTasks = new Dictionary<string, int>();
                if (zoneTasksByEmp.TryGetValue(executorId, out var ztRow))
                    foreach (var ((zcol, zone), v) in ztRow)
                        if (order.Contains(zcol)) zoneTasks[zone] = zoneTasks.GetValueOrDefault(zone) + v.Pieces + v.Kdk.Count;
                heRows.Add(new Dictionary<string, object?>
                {
                    ["zoneTasks"] = zoneTasks,
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
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (shift == "day")
            {
                idleShiftStartMs = new DateTimeOffset(d.Year, d.Month, d.Day, 6, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
                var shiftEndFullMs = new DateTimeOffset(d.Year, d.Month, d.Day, 18, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
                idleShiftEndMs = Math.Min(nowMs, shiftEndFullMs);
            }
            else
            {
                idleShiftStartMs = new DateTimeOffset(d.Year, d.Month, d.Day, 18, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
                var nextDate = d.AddDays(1);
                var shiftEndFullMs = new DateTimeOffset(nextDate.Year, nextDate.Month, nextDate.Day, 6, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
                idleShiftEndMs = Math.Min(nowMs, shiftEndFullMs);
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
    // Единственное хранилище операций WMS: /api/save-fetched-data (Node)
    // пересылает сюда сырые item'ы кусками. Почасовые JSON-файлы и утилиты
    // tools/* убраны 2026-10-31.

    public async Task<int> IngestOpsAsync(List<System.Text.Json.JsonElement> rawItems)
    {
        // Проход 1 — только распарсить (Date,Hour) каждого элемента (дёшево, без
        // обращений к БД), чтобы заранее собрать все уникальные пары и одним
        // запросом на пару подтянуть уже существующие merge_key. Раньше здесь на
        // КАЖДЫЙ элемент батча уходил отдельный `SELECT EXISTS(...)` — при батче
        // в тысячи операций (обычный размер одной часовой пачки) это давало по
        // несколько секунд ТОЛЬКО на проверку дублей, и совокупно по всем часовым
        // пачкам одного фетча — многие минуты.
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
            // GUID товара — ключ для справочника products/by-id, см. toLightItem()
            // в storage.js. В ответе поле называется productId (не id — у товара,
            // в отличие от responsibleUser, ключ именной).
            var productId = product != null ? (GetStr(product.Value, "productId") ?? "") : "";
            var targetAddr = GetObj(raw, "targetAddress");
            var sourceAddr = GetObj(raw, "sourceAddress");
            var cell = (targetAddr != null ? GetStr(targetAddr.Value, "cellAddress") : null)
                ?? (sourceAddr != null ? GetStr(sourceAddr.Value, "cellAddress") : null) ?? "";

            var targetBarcodeForKey = targetAddr != null ? (GetStr(targetAddr.Value, "handlingUnitBarcode") ?? "") : "";
            var mergeKey = GetMergeKeyFromLight(operationType, type, executor, cell, nomenclatureCode, productName, GetStr(raw, "id"), targetBarcodeForKey);

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
                ProductId = productId,
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
}
