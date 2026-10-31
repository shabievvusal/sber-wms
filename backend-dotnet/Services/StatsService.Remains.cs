using System.Globalization;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Остатки — консолидация зоны хранения (wms_remains): запись выгрузки и сводка.
public partial class StatsService
{
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
}
