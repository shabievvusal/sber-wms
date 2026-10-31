using System.Globalization;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Размещение (wms_placement): запись выгрузки и сводка за день.
public partial class StatsService
{
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
            // Таблица «По СЗ» — часовые бакеты col = (час + 1) % 24, как у
            // комплектации (BuildDateSummary; DAY_HOURS 10..21 на фронте):
            // с сырым часом операции 9:00–10:00 (ключ 9) в дневную смену не
            // попадали ни в одну колонку, а остальные стояли на колонку левее.
            // `hourly` (график) остаётся по сырому часу — тоже как у комплектации.
            var col = ((hour + 1) % 24).ToString();
            rec.ByHour[col] = rec.ByHour.GetValueOrDefault(col) + 1;
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
        // С 2026-10-23 размещение берётся из журнала stocks/changes
        // (STORAGE_PLACEMENT, wms_stock_moves). За дни до перехода там пусто —
        // тогда, чтобы не потерять историю, читаем прежнюю wms_placement
        // (задачи placement/tasks).
        var moves = await GetStockMoveOperationsAsync(OpStoragePlacement, dateStr, fromHour, toHour, shift);
        if (moves.Count > 0)
            return BuildPlacementSummary(FilterPlacementLike(moves, filterExecutorNorm, filterCompanies, idMap), idMap);

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
}
