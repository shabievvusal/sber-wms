using System.Globalization;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Приёмка (wms_receiving): запись выгрузки, сводка за день и строки за период.
public partial class StatsService
{
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
            // Вес в ответе inbound/tasks — actualTotalWeight (граммы); прежние
            // weightInGrams/actualWeightInGrams там не встречаются, из-за чего
            // вес приёмки всегда был 0. SKU — плановое (фактического WMS не
            // отдаёт), штуки — фактически принятые.
            var weightGrams = GetTopNum(raw, "actualTotalWeight") ?? GetTopNum(raw, "weightInGrams") ?? GetTopNum(raw, "actualWeightInGrams");
            var skuCount = GetTopNum(raw, "plannedSkuCount");
            var pieces = GetNum(GetObj(raw, "actualQuantities"), "pieceProducts");

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
                existing.WeightInGrams = weightGrams ?? existing.WeightInGrams;
                existing.EoCount = eoCount != 0 ? eoCount : existing.EoCount;
                existing.SkuCount = skuCount ?? existing.SkuCount;
                existing.Pieces = pieces ?? existing.Pieces;
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
                WeightInGrams = weightGrams ?? 0,
                EoCount = eoCount,
                SkuCount = skuCount ?? 0,
                Pieces = pieces ?? 0,
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

    // Поставки, по которым приёмщик уже сохранён: за ним браузер ходит в WMS
    // отдельным запросом на каждую поставку (responsible-users) — повторное
    // обновление смены пропускает эти поставки и не грузит WMS заново.
    // Строки, сохранённые до 2026-10-23, — без SKU/штук/веса: их не считаем
    // известными, чтобы они один раз перезаписались с полными данными.
    public async Task<List<string>> GetKnownReceivingIdsAsync(List<string> ids)
    {
        if (ids.Count == 0) return new();
        return await _db.WmsReceiving.AsNoTracking()
            .Where(r => ids.Contains(r.ItemId) && r.ExecutorId != "" && (r.SkuCount > 0 || r.Pieces > 0 || r.WeightInGrams > 0))
            .Select(r => r.ItemId)
            .Distinct()
            .ToListAsync();
    }

    public object BuildReceivingSummary(List<WmsReceivingEntity> items, Dictionary<string, string>? idMap)
    {
        var byExecutor = new Dictionary<string, (string Name, string ExecutorId, string Company, Dictionary<string, int> ByHour, Dictionary<string, decimal> SecondaryByHour, HashSet<string> TotalKeys, decimal SecondaryTotal, DateTime? FirstAt, DateTime? LastAt)>();
        var byHour = new Dictionary<int, (int Ops, decimal Secondary, HashSet<string> Employees)>();
        // SKU / штуки / вес поставок — по сотруднику и по часу (бакет col)
        var extraByExecutor = new Dictionary<string, Dictionary<string, (decimal Sku, decimal Pieces, decimal WeightGrams)>>();
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
            // бакет col = (час + 1) % 24 — см. BuildPlacementSummary
            var col = ((hour + 1) % 24).ToString();
            rec.ByHour[col] = rec.ByHour.GetValueOrDefault(col) + 1;
            rec.SecondaryByHour[col] = rec.SecondaryByHour.GetValueOrDefault(col) + eoCount;
            rec.SecondaryTotal += eoCount;
            if (rec.FirstAt == null || ts < rec.FirstAt) rec.FirstAt = ts;
            if (rec.LastAt == null || ts > rec.LastAt) rec.LastAt = ts;
            byExecutor[dictKey] = rec;
            if (!extraByExecutor.TryGetValue(dictKey, out var extra)) extraByExecutor[dictKey] = extra = new();
            var ex = extra.GetValueOrDefault(col);
            extra[col] = (ex.Sku + item.SkuCount, ex.Pieces + item.Pieces, ex.WeightGrams + item.WeightInGrams);

            if (!byHour.TryGetValue(hour, out var hh)) hh = (0, 0, new HashSet<string>());
            hh.Ops += 1;
            hh.Secondary += eoCount;
            if (dictKey != "") hh.Employees.Add(dictKey);
            byHour[hour] = hh;
        }
        var rows = byExecutor.Select(kv =>
        {
            var r = kv.Value;
            var extra = extraByExecutor.GetValueOrDefault(kv.Key) ?? new();
            return new
            {
                name = r.Name,
                executorId = r.ExecutorId != "" ? r.ExecutorId : null,
                company = r.Company,
                byHour = r.ByHour,
                secondaryByHour = r.SecondaryByHour,
                secondaryTotal = r.SecondaryTotal,
                skuByHour = extra.ToDictionary(e => e.Key, e => e.Value.Sku),
                piecesByHour = extra.ToDictionary(e => e.Key, e => e.Value.Pieces),
                weightGramsByHour = extra.ToDictionary(e => e.Key, e => e.Value.WeightGrams),
                skuTotal = extra.Values.Sum(e => e.Sku),
                piecesTotal = extra.Values.Sum(e => e.Pieces),
                weightGramsTotal = extra.Values.Sum(e => e.WeightGrams),
                byHourZone = new Dictionary<string, object?>(),
                byZone = new Dictionary<string, object?>(),
                weightByHour = new Dictionary<string, object?>(),
                total = r.TotalKeys.Count,
                firstAt = r.FirstAt,
                lastAt = r.LastAt,
            };
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
            totalSku = rows.Sum(r => r.skuTotal),
            totalPieces = rows.Sum(r => r.piecesTotal),
            totalWeightGrams = rows.Sum(r => r.weightGramsTotal),
            executors = rows.Select(r => new { name = r.name, executorId = r.executorId, ops = r.total, secondary = r.secondaryTotal, firstAt = r.firstAt, lastAt = r.lastAt }).ToList(),
            hourly,
            hourlyByEmployee = new { hours = hoursList, rows },
        };
    }

    // Приёмка за произвольный интервал времени завершения (фильтр «Дата
    // завершения» с датой и временем): часть приёмщиков выходит раньше начала
    // смены (например, к 8:00 на дневную) — так их работу можно собрать в
    // одну сводку, не разрываясь на границе смен.
    private async Task<List<WmsReceivingEntity>> GetReceivingItemsByCompletedAsync(DateTime fromUtc, DateTime toUtc)
    {
        var items = await _db.WmsReceiving.AsNoTracking()
            .Where(r => r.CompletedAt >= fromUtc && r.CompletedAt <= toUtc)
            .ToListAsync();
        items.Sort((a, b) => Nullable.Compare(a.CompletedAt, b.CompletedAt));
        return items;
    }

    public async Task<object> GetReceivingSummaryAsync(string dateStr, int? fromHour, int? toHour, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap, DateTime? completedFromUtc = null, DateTime? completedToUtc = null)
    {
        var items = await GetReceivingFilteredItemsAsync(dateStr, fromHour, toHour, shift, filterExecutorNorm, filterCompanies, idMap, completedFromUtc, completedToUtc);
        return BuildReceivingSummary(items, idMap);
    }

    // Поставки построчно — для Excel-отчёта по приёмке (те же фильтры, что у сводки).
    public async Task<List<object>> GetReceivingRowsAsync(string dateStr, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap, DateTime? completedFromUtc = null, DateTime? completedToUtc = null)
    {
        var items = await GetReceivingFilteredItemsAsync(dateStr, null, null, shift, filterExecutorNorm, filterCompanies, idMap, completedFromUtc, completedToUtc);
        return items.Select(r => ReceivingRow(r, idMap, null, null)).ToList();
    }

    // Поставки за период по датам смен: shift = day/night — только эта смена
    // каждой даты; null — обе (09:00 даты → 09:00 следующего дня), чтобы
    // соседние даты не пересекались. У строки — дата и смена, к которым она
    // отнесена (лист «По дням» Excel-отчёта и таблица «За период»).
    public async Task<List<object>> GetReceivingPeriodRowsAsync(string dateFrom, string dateTo, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap)
    {
        var result = new List<object>();
        foreach (var dateStr in GetDateRangeList(dateFrom, dateTo))
        {
            foreach (var s in shift == null ? new[] { "day", "night" } : new[] { shift })
            {
                var items = await GetReceivingFilteredItemsAsync(dateStr, null, null, s, filterExecutorNorm, filterCompanies, idMap, null, null);
                result.AddRange(items.Select(r => ReceivingRow(r, idMap, dateStr, s)));
            }
        }
        return result;
    }

    private static object ReceivingRow(WmsReceivingEntity r, Dictionary<string, string>? idMap, string? shiftDate, string? shift) => new
    {
        shiftDate,
        shift,
        id = r.ItemId,
        taskNumber = r.TaskNumber,
        orderNumber = r.OrderNumber,
        supplierName = r.SupplierName,
        type = r.Type,
        status = r.Status,
        startedAt = r.StartedAt,
        completedAt = r.CompletedAt,
        executorId = r.ExecutorId,
        executor = r.Executor,
        company = ResolveCompany(idMap, r.ExecutorId) ?? "—",
        eo = r.EoCount,
        sku = r.SkuCount,
        pieces = r.Pieces,
        weightGrams = r.WeightInGrams,
    };

    private async Task<List<WmsReceivingEntity>> GetReceivingFilteredItemsAsync(string dateStr, int? fromHour, int? toHour, string? shift, string? filterExecutorNorm, List<string>? filterCompanies, Dictionary<string, string>? idMap, DateTime? completedFromUtc, DateTime? completedToUtc)
    {
        var items = completedFromUtc != null && completedToUtc != null
            ? await GetReceivingItemsByCompletedAsync(completedFromUtc.Value, completedToUtc.Value)
            : await GetReceivingItemsAsync(dateStr, fromHour, toHour, shift);
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
