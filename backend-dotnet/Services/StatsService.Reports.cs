using Microsoft.EntityFrameworkCore;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Данные для Excel-отчётов и вкладки «За период» по операциям (кроме
// приёмки — она в StatsService.cs, GetReceivingPeriodRowsAsync).
//
// Спуск/пополнение/размещение и остатки — построчно (браузер сам считает
// разрезы, как у приёмки). Комплектация — агрегатами на сервере: строк за
// период — сотни тысяч, отдавать их в браузер нельзя.
//
// Период режется по сменам: shift = day/night — только эта смена каждой
// даты, null — обе (09:00 даты → 09:00 следующего дня), чтобы соседние даты
// не пересекались. У строки — дата смены (shiftDate) и смена.
public partial class StatsService
{
    private static IEnumerable<(string Date, string Shift)> ShiftSlices(string dateFrom, string dateTo, string? shift)
    {
        foreach (var d in GetDateRangeList(dateFrom, dateTo))
            foreach (var s in shift == null ? new[] { "day", "night" } : new[] { shift })
                yield return (d, s);
    }

    private static bool PassesFilters(string? executor, string? executorId, string? filterExecutorNorm, HashSet<string>? allowedCompanies, Dictionary<string, string>? idMap)
    {
        if (!string.IsNullOrEmpty(filterExecutorNorm) && NormalizeFioSummary(executor) != filterExecutorNorm) return false;
        if (allowedCompanies != null)
        {
            var company = ResolveCompany(idMap, executorId);
            if (string.IsNullOrEmpty(company) || !allowedCompanies.Contains(company.Trim().ToLowerInvariant())) return false;
        }
        return true;
    }

    private static HashSet<string>? AllowedCompanies(List<string>? filterCompanies) =>
        filterCompanies is { Count: > 0 } ? new HashSet<string>(filterCompanies.Select(c => c.Trim().ToLowerInvariant())) : null;

    // ─── Спуск / пополнение / размещение (wms_stock_moves) — по строкам-товарам ─

    public async Task<List<object>> GetStockMoveRowsAsync(string operationType, string dateFrom, string dateTo, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var weightMap = await GetWeightMapAsync();
        var allowed = AllowedCompanies(filterCompanies);
        var result = new List<object>();
        foreach (var (dateStr, s) in ShiftSlices(dateFrom, dateTo, shift))
        {
            var pairs = GetHoursToLoad(DateOnly.Parse(dateStr), null, null, s);
            var dates = pairs.Select(p => p.Date).Distinct().ToList();
            var hours = pairs.Select(p => p.Hour).Distinct().ToList();
            var pairSet = new HashSet<(DateOnly, int)>(pairs);
            var rows = await _db.WmsStockMoves.AsNoTracking()
                .Where(m => m.OperationType == operationType && dates.Contains(m.Date) && hours.Contains((int)m.Hour))
                .ToListAsync();
            foreach (var m in rows)
            {
                if (!pairSet.Contains((m.Date, (int)m.Hour))) continue;
                if (!PassesFilters(m.Executor, m.ExecutorId, filterExecutorNorm, allowed, idMap)) continue;
                var gramsPerUnit = GetWeightGrams(weightMap, m.NomenclatureCode);
                result.Add(new
                {
                    shiftDate = dateStr,
                    shift = s,
                    completedAt = m.CompletedAt,
                    startedAt = m.StartedAt,
                    executorId = m.ExecutorId,
                    executor = m.Executor,
                    company = ResolveCompany(idMap, m.ExecutorId) ?? "—",
                    sourceCell = m.SourceCellAddress,
                    sourceHu = m.SourceHandlingUnitBarcode,
                    targetCell = m.TargetCellAddress,
                    targetHu = m.TargetHandlingUnitBarcode,
                    code = m.NomenclatureCode,
                    name = m.ProductName,
                    qty = m.Quantity,
                    // нет веса в справочнике — null (отличаем от «0 г»)
                    grams = gramsPerUnit > 0 ? gramsPerUnit * Math.Max(1, m.Quantity) : (decimal?)null,
                });
            }
        }
        return result;
    }

    // ─── Остатки (объединение, wms_remains) — по операциям ─────────────────────

    public async Task<List<object>> GetRemainsRowsAsync(string dateFrom, string dateTo, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var allowed = AllowedCompanies(filterCompanies);
        var result = new List<object>();
        foreach (var (dateStr, s) in ShiftSlices(dateFrom, dateTo, shift))
        {
            var items = await GetRemainsItemsAsync(dateStr, null, null, s);
            foreach (var r in items)
            {
                if (!PassesFilters(r.Executor, r.ExecutorId, filterExecutorNorm, allowed, idMap)) continue;
                result.Add(new
                {
                    shiftDate = dateStr,
                    shift = s,
                    completedAt = r.CreatedAt,
                    executorId = r.ExecutorId,
                    executor = r.Executor,
                    company = ResolveCompany(idMap, r.ExecutorId) ?? "—",
                    taskType = r.TaskType,
                    sourceCell = r.SourceCellAddress,
                    sourceHu = r.SourceHandlingUnitBarcode,
                    targetCell = r.TargetCellAddress,
                    targetHu = r.TargetHandlingUnitBarcode,
                    positions = r.ConsolidationItems.Count,
                    qty = r.ConsolidationItems.Sum(ConsolidationQty),
                });
            }
        }
        return result;
    }

    // Количество в позиции объединения: состав consolidationItems в WMS не
    // описан — берём первое найденное числовое поле количества.
    private static decimal ConsolidationQty(System.Text.Json.JsonElement el)
    {
        if (el.ValueKind != System.Text.Json.JsonValueKind.Object) return 0;
        foreach (var name in new[] { "quantity", "actualQuantity", "qty", "count" })
        {
            if (!el.TryGetProperty(name, out var v)) continue;
            if (v.ValueKind == System.Text.Json.JsonValueKind.Number) return v.GetDecimal();
            if (v.ValueKind == System.Text.Json.JsonValueKind.Object && v.TryGetProperty("pieceProducts", out var pp) && pp.ValueKind == System.Text.Json.JsonValueKind.Number) return pp.GetDecimal();
        }
        return 0;
    }

    // ─── Товары без веса в справочнике — для дозапроса веса из WMS ─────────────
    // Артикулы из комплектации и спуска/пополнения/размещения за последние
    // `days` дней, которых нет в product_weights. productId — GUID товара в
    // WMS (у старых строк журнала перемещений может быть пустым — тогда браузер
    // сначала ищет товар по артикулу). Сначала самые частые.
    public async Task<List<object>> GetMissingWeightProductsAsync(int days)
    {
        var since = DateOnly.FromDateTime(ToMoscow(DateTime.UtcNow)).AddDays(-days);
        var weightMap = await GetWeightMapAsync();
        var found = new Dictionary<string, (string Name, string ProductId, int Uses)>();
        void Add(string? code, string? name, string? productId, int uses)
        {
            var c = (code ?? "").Trim();
            if (c == "" || GetWeightGrams(weightMap, c) > 0) return;
            var cur = found.GetValueOrDefault(c, ("", "", 0));
            found[c] = (cur.Item1 != "" ? cur.Item1 : (name ?? ""), cur.Item2 != "" ? cur.Item2 : (productId ?? ""), cur.Item3 + uses);
        }

        var ops = await _db.WmsOps.AsNoTracking()
            .Where(o => o.Date >= since && o.NomenclatureCode != "")
            .GroupBy(o => o.NomenclatureCode)
            .Select(g => new { Code = g.Key, Name = g.Max(o => o.ProductName), ProductId = g.Max(o => o.ProductId), Uses = g.Count() })
            .ToListAsync();
        foreach (var r in ops) Add(r.Code, r.Name, r.ProductId, r.Uses);

        var moves = await _db.WmsStockMoves.AsNoTracking()
            .Where(m => m.Date >= since && m.NomenclatureCode != "")
            .GroupBy(m => m.NomenclatureCode)
            .Select(g => new { Code = g.Key, Name = g.Max(m => m.ProductName), ProductId = g.Max(m => m.ProductId), Uses = g.Count() })
            .ToListAsync();
        foreach (var r in moves) Add(r.Code, r.Name, r.ProductId, r.Uses);

        return found.OrderByDescending(kv => kv.Value.Uses)
            .Select(kv => (object)new { code = kv.Key, name = kv.Value.Name, productId = kv.Value.ProductId, uses = kv.Value.Uses })
            .ToList();
    }

    // ─── Комплектация (wms_ops) — агрегаты на сервере ──────────────────────────

    private sealed class SelAgg
    {
        public HashSet<string> Tasks = new();
        public HashSet<string> KdkTasks = new();
        public decimal Qty;
        public decimal Grams;
        public HashSet<string> Executors = new();
        public HashSet<string> Days = new();
        public HashSet<long> ActiveHours = new();
        public HashSet<string> Products = new();
        public HashSet<string> Cells = new();
        public DateTime? First;
        public DateTime? Last;
        public string Name = "";
        public string Company = "—";

        public void Add(WmsOpEntity item, string taskKey, bool isKdk, decimal grams, string shiftDate)
        {
            Tasks.Add(taskKey);
            if (isKdk) KdkTasks.Add(taskKey);
            Qty += item.Quantity ?? 0;
            Grams += grams;
            if (!string.IsNullOrEmpty(item.ExecutorId)) Executors.Add(item.ExecutorId);
            Days.Add(shiftDate);
            var ts = item.CompletedAt;
            if (ts != null)
            {
                ActiveHours.Add(new DateTimeOffset(DateTime.SpecifyKind(ts.Value, DateTimeKind.Utc)).ToUnixTimeSeconds() / 3600);
                if (First == null || ts < First) First = ts;
                if (Last == null || ts > Last) Last = ts;
            }
            if (!string.IsNullOrEmpty(item.NomenclatureCode)) Products.Add(item.NomenclatureCode);
            if (!string.IsNullOrEmpty(item.Cell)) Cells.Add(item.Cell);
        }

        public object ToJson(string key) => new
        {
            key,
            name = Name,
            company = Company,
            tasks = Tasks.Count,
            kdkTasks = KdkTasks.Count,
            storageTasks = Tasks.Count - KdkTasks.Count,
            qty = Qty,
            grams = Grams,
            executors = Executors.Count,
            days = Days.Count,
            activeHours = ActiveHours.Count,
            products = Products.Count,
            cells = Cells.Count,
            first = First,
            last = Last,
        };
    }

    public async Task<object> GetSelectionReportAsync(string dateFrom, string dateTo, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var weightMap = await GetWeightMapAsync();
        var allowed = AllowedCompanies(filterCompanies);
        var total = new SelAgg();
        var byExecutor = new Dictionary<string, SelAgg>();
        var byCompany = new Dictionary<string, SelAgg>();
        var byZone = new Dictionary<string, SelAgg>();
        var byDay = new Dictionary<string, SelAgg>();
        var byHour = new Dictionary<int, SelAgg>();
        var byProduct = new Dictionary<string, SelAgg>();
        var byCell = new Dictionary<string, SelAgg>();
        var matrix = new Dictionary<(string Executor, int Hour), HashSet<string>>();
        var missingWeight = new Dictionary<string, (string Name, decimal Qty, int Picks)>();

        SelAgg Get<TKey>(Dictionary<TKey, SelAgg> map, TKey key) where TKey : notnull
        {
            if (!map.TryGetValue(key, out var a)) map[key] = a = new SelAgg();
            return a;
        }

        foreach (var (dateStr, s) in ShiftSlices(dateFrom, dateTo, shift))
        {
            var items = await GetDateItemsAsync(dateStr, null, null, s);
            foreach (var item in items)
            {
                var type = (item.OperationType ?? "").ToUpperInvariant();
                var isKdk = type == "PICK_BY_LINE";
                if (!isKdk && type != "PIECE_SELECTION_PICKING") continue;
                if (!PassesFilters(item.Executor, item.ExecutorId, filterExecutorNorm, allowed, idMap)) continue;

                var taskKey = GetTaskKeySummary(item);
                var article = (item.NomenclatureCode ?? "").Trim();
                var gramsPerUnit = GetWeightGrams(weightMap, article);
                var grams = gramsPerUnit > 0 ? gramsPerUnit * Math.Max(1, item.Quantity ?? 1) : 0;
                if (gramsPerUnit <= 0 && !string.IsNullOrEmpty(item.ProductName))
                {
                    var mk = article != "" ? article : item.ProductName.Trim();
                    var cur = missingWeight.GetValueOrDefault(mk, (item.ProductName.Trim(), 0m, 0));
                    missingWeight[mk] = (cur.Item1, cur.Item2 + (item.Quantity ?? 0), cur.Item3 + 1);
                }
                var company = ResolveCompany(idMap, item.ExecutorId) ?? "—";
                var zone = (item.Cell ?? "").Split('-')[0].ToUpperInvariant();
                var hour = item.CompletedAt != null ? ToMoscow(item.CompletedAt.Value).Hour : -1;

                total.Add(item, taskKey, isKdk, grams, dateStr);
                var ex = Get(byExecutor, string.IsNullOrEmpty(item.ExecutorId) ? (item.Executor ?? "—") : item.ExecutorId);
                ex.Name = !string.IsNullOrEmpty(item.Executor) ? item.Executor : ex.Name;
                ex.Company = company;
                ex.Add(item, taskKey, isKdk, grams, dateStr);
                Get(byCompany, company).Add(item, taskKey, isKdk, grams, dateStr);
                Get(byZone, zone == "" ? "—" : zone).Add(item, taskKey, isKdk, grams, dateStr);
                Get(byDay, dateStr).Add(item, taskKey, isKdk, grams, dateStr);
                if (hour >= 0)
                {
                    Get(byHour, hour).Add(item, taskKey, isKdk, grams, dateStr);
                    var mkey = (string.IsNullOrEmpty(item.ExecutorId) ? (item.Executor ?? "—") : item.ExecutorId, hour);
                    if (!matrix.TryGetValue(mkey, out var set)) matrix[mkey] = set = new HashSet<string>();
                    set.Add(taskKey);
                }
                var pkey = article != "" ? article : (item.ProductName ?? "—");
                var pa = Get(byProduct, pkey);
                pa.Name = item.ProductName ?? pa.Name;
                pa.Add(item, taskKey, isKdk, grams, dateStr);
                if (!string.IsNullOrEmpty(item.Cell)) Get(byCell, item.Cell).Add(item, taskKey, isKdk, grams, dateStr);
            }
        }

        var hourOrder = byHour.Keys.OrderBy(h => (h - 9 + 24) % 24).ToList();
        return new
        {
            dateFrom,
            dateTo,
            shift,
            totals = total.ToJson("all"),
            executors = byExecutor.Select(kv => kv.Value.ToJson(kv.Key)).ToList(),
            companies = byCompany.Select(kv => kv.Value.ToJson(kv.Key)).ToList(),
            zones = byZone.Select(kv => kv.Value.ToJson(kv.Key)).ToList(),
            days = byDay.OrderBy(kv => kv.Key).Select(kv => kv.Value.ToJson(kv.Key)).ToList(),
            hours = hourOrder.Select(h => byHour[h].ToJson(h.ToString())).ToList(),
            // топ-500 — дальше «хвост» в одну-две операции, только раздувает файл
            products = byProduct.OrderByDescending(kv => kv.Value.Tasks.Count).Take(500).Select(kv => kv.Value.ToJson(kv.Key)).ToList(),
            cells = byCell.OrderByDescending(kv => kv.Value.Tasks.Count).Take(500).Select(kv => kv.Value.ToJson(kv.Key)).ToList(),
            matrix = matrix.Select(kv => new { executor = kv.Key.Executor, hour = kv.Key.Hour, tasks = kv.Value.Count }).ToList(),
            hourOrder,
            missingWeight = missingWeight.OrderByDescending(kv => kv.Value.Picks).Select(kv => new { code = kv.Key, name = kv.Value.Name, qty = kv.Value.Qty, picks = kv.Value.Picks }).ToList(),
        };
    }
}
