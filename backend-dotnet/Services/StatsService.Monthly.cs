using System.Globalization;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Месячные сводки: по компаниям и по сотрудникам.
public partial class StatsService
{
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
}
