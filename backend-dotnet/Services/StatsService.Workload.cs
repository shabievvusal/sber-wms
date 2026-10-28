using Microsoft.EntityFrameworkCore;

namespace BackendDotnet.Services;

// Выработка «сотрудник × смена» по операциям — для итога смены и сравнения
// с нормой (страница «Итоги смены»). Агрегаты на сервере: построчно за месяц
// это сотни тысяч строк. Единица операции — как в статистике:
//   receiving — поставка; kdk / piece — СЗ (раскладка КДК / штучный отбор);
//   movedown / refill / placement — ЕО + сотрудник + время завершения.
// hours — число часов, в которые сотрудник что-то завершил (как «отработано»
// в статистике); производительность = units / hours.
public partial class StatsService
{
    public static readonly string[] WorkloadOps = { "receiving", "placement", "movedown", "refill", "kdk", "piece" };

    private sealed class WorkAgg
    {
        public string ShiftDate = "", Shift = "", ExecutorId = "", Name = "", Company = "—";
        public HashSet<string> Units = new();
        public decimal Qty, Grams;
        public HashSet<long> Hours = new();
        public DateTime? First, Last;

        public void Touch(DateTime? ts)
        {
            if (ts == null) return;
            Hours.Add(new DateTimeOffset(DateTime.SpecifyKind(ts.Value, DateTimeKind.Utc)).ToUnixTimeSeconds() / 3600);
            if (First == null || ts < First) First = ts;
            if (Last == null || ts > Last) Last = ts;
        }

        public object ToJson() => new
        {
            shiftDate = ShiftDate, shift = Shift, executorId = ExecutorId, name = Name, company = Company,
            units = Units.Count, qty = Qty, grams = Grams, hours = Hours.Count, first = First, last = Last,
        };
    }

    public async Task<List<object>> GetWorkloadAsync(string op, string dateFrom, string dateTo, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var allowed = AllowedCompanies(filterCompanies);
        var weightMap = op == "receiving" ? null : await GetWeightMapAsync();
        var result = new List<object>();
        foreach (var (dateStr, s) in ShiftSlices(dateFrom, dateTo, shift))
        {
            var map = new Dictionary<string, WorkAgg>();
            WorkAgg Get(string? executorId, string? executor)
            {
                var key = string.IsNullOrEmpty(executorId) ? (executor ?? "—") : executorId;
                if (!map.TryGetValue(key, out var a))
                    map[key] = a = new WorkAgg { ShiftDate = dateStr, Shift = s, ExecutorId = executorId ?? "", Company = ResolveCompany(idMap, executorId) ?? "—" };
                if (!string.IsNullOrEmpty(executor)) a.Name = executor;
                return a;
            }

            if (op == "receiving")
            {
                foreach (var r in await GetReceivingItemsAsync(dateStr, null, null, s))
                {
                    if (string.IsNullOrEmpty(r.ExecutorId) && string.IsNullOrEmpty(r.Executor)) continue;
                    if (!PassesFilters(r.Executor, r.ExecutorId, filterExecutorNorm, allowed, idMap)) continue;
                    var a = Get(r.ExecutorId, r.Executor);
                    a.Units.Add(string.IsNullOrEmpty(r.ItemId) ? $"{r.TaskNumber}|{r.CompletedAt:O}" : r.ItemId);
                    a.Qty += r.Pieces;
                    a.Grams += r.WeightInGrams;
                    a.Touch(r.CompletedAt);
                }
            }
            else if (op == "kdk" || op == "piece")
            {
                var wanted = op == "kdk" ? "PICK_BY_LINE" : "PIECE_SELECTION_PICKING";
                foreach (var item in await GetDateItemsAsync(dateStr, null, null, s))
                {
                    if (!string.Equals(item.OperationType, wanted, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!PassesFilters(item.Executor, item.ExecutorId, filterExecutorNorm, allowed, idMap)) continue;
                    var a = Get(item.ExecutorId, item.Executor);
                    a.Units.Add(GetTaskKeySummary(item));
                    a.Qty += item.Quantity ?? 0;
                    var g = GetWeightGrams(weightMap!, (item.NomenclatureCode ?? "").Trim());
                    if (g > 0) a.Grams += g * Math.Max(1, item.Quantity ?? 1);
                    a.Touch(item.CompletedAt);
                }
            }
            else
            {
                var opType = op switch { "movedown" => OpDescent, "refill" => OpReplenishment, "placement" => OpStoragePlacement, _ => null };
                if (opType == null) throw new ArgumentException("Неизвестная операция");
                var pairs = GetHoursToLoad(DateOnly.Parse(dateStr), null, null, s);
                var dates = pairs.Select(p => p.Date).Distinct().ToList();
                var hours = pairs.Select(p => p.Hour).Distinct().ToList();
                var pairSet = new HashSet<(DateOnly, int)>(pairs);
                var rows = await _db.WmsStockMoves.AsNoTracking()
                    .Where(m => m.OperationType == opType && dates.Contains(m.Date) && hours.Contains((int)m.Hour))
                    .ToListAsync();
                foreach (var m in rows)
                {
                    if (!pairSet.Contains((m.Date, (int)m.Hour))) continue;
                    if (!PassesFilters(m.Executor, m.ExecutorId, filterExecutorNorm, allowed, idMap)) continue;
                    var a = Get(m.ExecutorId, m.Executor);
                    a.Units.Add($"{m.SourceHandlingUnitBarcode}|{m.CompletedAt:O}");
                    a.Qty += m.Quantity;
                    var g = GetWeightGrams(weightMap!, m.NomenclatureCode);
                    if (g > 0) a.Grams += g * Math.Max(1, m.Quantity);
                    a.Touch(m.CompletedAt);
                }
            }
            result.AddRange(map.Values.Where(a => a.Units.Count > 0).Select(a => a.ToJson()));
        }
        return result;
    }
}

// Расстановка товара по оборачиваемости: сколько раз за период отбирали
// товар из ячейки (штучный отбор). Дубли строк WMS — по item_id.
public class SlotRow
{
    public string Cell { get; set; } = "";
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public int Lines { get; set; }
    public decimal Qty { get; set; }
    public DateTime LastAt { get; set; }
}

public partial class StatsService
{
    public Task<List<SlotRow>> GetSlottingAsync(DateOnly from, DateOnly to)
    {
        // смены дат: 09:00 МСК первой даты → 09:00 МСК дня после последней
        var fromUtc = DateTime.SpecifyKind(from.ToDateTime(new TimeOnly(6, 0)), DateTimeKind.Utc);
        var toUtc = DateTime.SpecifyKind(to.AddDays(1).ToDateTime(new TimeOnly(6, 0)), DateTimeKind.Utc);
        return _db.Database.SqlQueryRaw<SlotRow>(@"
            WITH d AS (
              SELECT DISTINCT ON (CASE WHEN item_id <> '' THEN item_id ELSE id::text END)
                     cell, nomenclature_code, product_name, quantity, completed_at
                FROM wms_ops
               WHERE warehouse_id = @wh AND operation_type = 'PIECE_SELECTION_PICKING'
                 AND completed_at >= @f AND completed_at < @t AND cell <> ''
               ORDER BY CASE WHEN item_id <> '' THEN item_id ELSE id::text END
            )
            SELECT cell AS ""Cell"", coalesce(nomenclature_code, '') AS ""Code"", max(product_name) AS ""Name"",
                   count(*)::int AS ""Lines"", coalesce(sum(quantity), 0) AS ""Qty"", max(completed_at) AS ""LastAt""
              FROM d GROUP BY cell, nomenclature_code",
            new Npgsql.NpgsqlParameter("wh", _db.WarehouseId),
            new Npgsql.NpgsqlParameter("f", NpgsqlTypes.NpgsqlDbType.TimestampTz) { Value = fromUtc },
            new Npgsql.NpgsqlParameter("t", NpgsqlTypes.NpgsqlDbType.TimestampTz) { Value = toUtc }).ToListAsync();
    }
}
