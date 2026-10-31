using System.Globalization;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Журнал перемещений ЕО (wms_stock_moves): спуск, пополнение, размещение; новые сотрудники из выгрузки.
public partial class StatsService
{
    // ─── Журнал перемещений ЕО: спуск / пополнение / размещение ─────────────────
    // Источник — stocks/changes/search (тот же журнал, что у комплектации), но
    // отдельная таблица: в wms_ops каждая строка считалась бы сборочным
    // заданием. Строка WMS — один товар; одна ЕО у одного сотрудника с одним
    // временем завершения — одна операция (схлопывается в GetStockMoveOperationsAsync).
    // Час — по operationCompletedAt (Москва).

    public const string OpDescent = "PIECE_SELECTION_HANDLING_UNIT_DESCENT";
    public const string OpReplenishment = "PIECE_SELECTION_PICKING_REPLENISHMENT";
    public const string OpStoragePlacement = "STORAGE_PLACEMENT";

    public async Task<(int Added, int Skipped)> SaveStockMovesAsync(List<System.Text.Json.JsonElement> rawItems)
    {
        int added = 0, skipped = 0;
        // См. комментарий в IngestOpsAsync/SavePlacementItemsAsync — один запрос
        // на уникальную (Date,Hour) вместо запроса на каждый элемент батча.
        var dateHourPairs = new HashSet<(DateOnly, short)>();
        foreach (var raw in rawItems)
        {
            var slotForPass = MoscowDateHour(ParseDate(GetStr(raw, "operationCompletedAt")));
            if (slotForPass != null) dateHourPairs.Add((slotForPass.Value.Date, (short)slotForPass.Value.Hour));
        }
        var batchByKey = new Dictionary<(DateOnly Date, short Hour, string MergeKey), WmsStockMoveEntity>();
        foreach (var (date, hour) in dateHourPairs)
        {
            var rows = await _db.WmsStockMoves.Where(m => m.Date == date && m.Hour == hour).ToListAsync();
            foreach (var row in rows) batchByKey[(date, hour, row.MergeKey)] = row;
        }

        foreach (var raw in rawItems)
        {
            var completedAt = ParseDate(GetStr(raw, "operationCompletedAt"));
            var slot = MoscowDateHour(completedAt);
            if (slot == null) continue;
            var itemId = (GetStr(raw, "id") ?? "").Trim();
            if (itemId == "") continue;
            var key = (slot.Value.Date, (short)slot.Value.Hour, itemId);
            // Завершённая строка журнала больше не меняется — повтор просто пропускаем.
            if (batchByKey.ContainsKey(key)) { skipped++; continue; }

            var ru = GetObj(raw, "responsibleUser");
            var responsibleUser = new ResponsibleUser
            {
                Id = ru != null ? (GetStr(ru.Value, "id") ?? "") : "",
                FirstName = ru != null ? (GetStr(ru.Value, "firstName") ?? "") : "",
                LastName = ru != null ? (GetStr(ru.Value, "lastName") ?? "") : "",
                MiddleName = ru != null ? (GetStr(ru.Value, "middleName") ?? "") : "",
            };
            var source = GetObj(raw, "sourceAddress");
            var target = GetObj(raw, "targetAddress");
            var product = GetObj(raw, "product");
            var targetQty = GetObj(raw, "targetQuantity");
            var row = new WmsStockMoveEntity
            {
                Date = slot.Value.Date,
                Hour = (short)slot.Value.Hour,
                MergeKey = itemId,
                OperationType = GetStr(raw, "operationType") ?? "",
                SourceCellAddress = source != null ? (GetStr(source.Value, "cellAddress") ?? "") : "",
                SourceHandlingUnitBarcode = source != null ? (GetStr(source.Value, "handlingUnitBarcode") ?? "") : "",
                TargetCellAddress = target != null ? (GetStr(target.Value, "cellAddress") ?? "") : "",
                TargetHandlingUnitBarcode = target != null ? (GetStr(target.Value, "handlingUnitBarcode") ?? "") : "",
                NomenclatureCode = product != null ? (GetStr(product.Value, "nomenclatureCode") ?? "") : "",
                ProductName = product != null ? (GetStr(product.Value, "name") ?? "") : "",
                ProductId = product != null ? (GetStr(product.Value, "productId") ?? "") : "",
                Quantity = (GetNum(targetQty, "newQuantity") ?? 0) - (GetNum(targetQty, "oldQuantity") ?? 0),
                ResponsibleUser = responsibleUser,
                ExecutorId = responsibleUser.Id,
                Executor = !string.IsNullOrEmpty(NormalizePlacementUser(responsibleUser)) ? NormalizePlacementUser(responsibleUser) : responsibleUser.Id,
                StartedAt = ParseDate(GetStr(raw, "operationStartedAt")),
                CompletedAt = completedAt,
            };
            _db.WmsStockMoves.Add(row);
            batchByKey[key] = row;
            added++;
        }
        await _db.SaveChangesAsync();
        return (added, skipped);
    }

    // Исполнители из выгрузки, которых нет в списке сотрудников склада, —
    // для подсказки «Новые сотрудники из WMS» после обновления данных (как
    // newEmployees у Node-маршрутов). Сверка только по executorId.
    public async Task<List<object>> FindNewEmployeesAsync(List<System.Text.Json.JsonElement> rawItems)
    {
        var candidates = new Dictionary<string, string>();
        foreach (var raw in rawItems)
        {
            var ru = GetObj(raw, "responsibleUser");
            if (ru == null) continue;
            var id = (GetStr(ru.Value, "id") ?? "").Trim();
            if (id == "") continue;
            var fio = NormalizePlacementUser(new ResponsibleUser
            {
                FirstName = GetStr(ru.Value, "firstName") ?? "",
                LastName = GetStr(ru.Value, "lastName") ?? "",
                MiddleName = GetStr(ru.Value, "middleName") ?? "",
            });
            if (fio == "") continue;
            candidates.TryAdd(id, fio); // ФИО — как прислал WMS по этому ID
        }
        if (candidates.Count == 0) return new();
        var ids = candidates.Keys.ToList();
        var known = new HashSet<string>(await _db.Employees.AsNoTracking().Where(e => ids.Contains(e.ExecutorId)).Select(e => e.ExecutorId).ToListAsync());
        return candidates.Where(kv => !known.Contains(kv.Key)).Select(kv => (object)new { executorId = kv.Key, fio = kv.Value }).ToList();
    }

    // Строки журнала за часы запроса, схлопнутые в операции (ЕО + сотрудник +
    // время завершения), в форме WmsPlacementEntity для BuildPlacementSummary.
    private async Task<List<WmsPlacementEntity>> GetStockMoveOperationsAsync(string operationType, string dateStr, int? fromHour, int? toHour, string? shift)
    {
        var date = DateOnly.Parse(dateStr);
        var pairs = GetHoursToLoad(date, fromHour, toHour, shift);
        var dates = pairs.Select(p => p.Date).Distinct().ToList();
        var hours = pairs.Select(p => p.Hour).Distinct().ToList();
        var candidates = await _db.WmsStockMoves.AsNoTracking()
            .Where(m => m.OperationType == operationType && dates.Contains(m.Date) && hours.Contains((int)m.Hour))
            .ToListAsync();
        var pairSet = new HashSet<(DateOnly, int)>(pairs);
        return candidates
            .Where(m => pairSet.Contains((m.Date, (int)m.Hour)))
            .GroupBy(m => (m.ExecutorId, m.SourceHandlingUnitBarcode, m.CompletedAt))
            .Select(g =>
            {
                var first = g.First();
                return new WmsPlacementEntity
                {
                    ItemId = $"{first.SourceHandlingUnitBarcode}|{first.CompletedAt:o}|{first.ExecutorId}",
                    HandlingUnitBarcode = first.SourceHandlingUnitBarcode,
                    TargetCellAddress = first.TargetCellAddress,
                    Executor = first.Executor,
                    ExecutorId = first.ExecutorId,
                    CreatedAt = first.CompletedAt,
                };
            })
            .OrderBy(p => p.CreatedAt)
            .ToList();
    }

    public async Task<object> GetStockMovesSummaryAsync(string operationType, string dateStr, int? fromHour, int? toHour, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var items = await GetStockMoveOperationsAsync(operationType, dateStr, fromHour, toHour, shift);
        return BuildPlacementSummary(FilterPlacementLike(items, filterExecutorNorm, filterCompanies, idMap), idMap);
    }

    private static List<WmsPlacementEntity> FilterPlacementLike(List<WmsPlacementEntity> items, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
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
        return items;
    }
}
