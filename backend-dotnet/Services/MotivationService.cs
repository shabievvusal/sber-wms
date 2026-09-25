using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Json;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Мотивация аутсорса (2026-09-25). Подрядчик к сроку (день — 10:00, ночь —
// 22:00) сообщает, под какой учёткой WMS работает каждый человек из его
// акта. По выработке учётки за смену считаются часы в акт:
//   — выполнение = min(доля нормы по СЗ, доля нормы по весу) — вес
//     обязателен наравне с СЗ;
//   — смешанная работа: доли хранения и КДК складываются
//     (450/900 + 750/1500 = 100%);
//   — недобор/перевыполнение переводятся в часы по «СЗ за 1 час»
//     (хранение 100, КДК 200) и округляются шагом RoundStep к нулю:
//     снимаются только полные шаги (в пользу работника), добавляются тоже
//     только полные (в пользу склада);
//   — нет учётки / учётка после срока / нет отбора под учёткой — 0 часов.
// СЗ считаются так же, как колонка «Итого» в почасовой таблице статистики
// (StatsService.BuildSummaryFromItems): хранение — каждая запись
// PIECE_SELECTION_PICKING, КДК — уникальные «товар+ячейка» в пределах часа.
public class MotivationService
{
    private const string SettingsKey = "norms";
    private const int MoscowUtcOffsetHours = 3;

    private readonly AppDbContext _db;
    private readonly StatsService _stats;

    public MotivationService(AppDbContext db, StatsService stats)
    {
        _db = db;
        _stats = stats;
    }

    private static string Clean(string? value) => (value ?? "").Trim();

    private static string NormName(string? s) =>
        Regex.Replace((s ?? "").Trim(), @"\s+", " ").ToLowerInvariant();

    public static void ValidateShift(string? date, string? shift)
    {
        if (!DateOnly.TryParseExact(date ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            throw new ArgumentException("Некорректная дата (ожидается YYYY-MM-DD)");
        if (shift != "day" && shift != "night") throw new ArgumentException("Смена должна быть day или night");
    }

    private static DateTime? ParseInstantUtc(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed)
            ? parsed.UtcDateTime
            : throw new ArgumentException("Некорректное время получения");
    }

    private static string NormalizeRole(string? role) =>
        Clean(role) == MotivationRoles.Other ? MotivationRoles.Other : MotivationRoles.Picker;

    private static MotivationPersonDto ToDto(MotivationPersonEntity e) => new()
    {
        Id = e.Id,
        Date = e.ShiftDate.ToString("yyyy-MM-dd"),
        Shift = e.Shift,
        Company = e.Company,
        Fio = e.Fio,
        Role = e.Role,
        ExecutorId = e.ExecutorId,
        ExecutorName = e.ExecutorName,
        ReceivedAt = e.ReceivedAt.HasValue ? DateTime.SpecifyKind(e.ReceivedAt.Value, DateTimeKind.Utc).ToString("o") : null,
    };

    // ─── Настройки ───────────────────────────────────────────────────────────

    public async Task<MotivationSettings> GetSettingsAsync()
    {
        var rows = await _db.Database.SqlQuery<string>(
            $"SELECT value AS \"Value\" FROM motivation_settings WHERE key = {SettingsKey}").ToListAsync();
        if (rows.Count == 0 || string.IsNullOrWhiteSpace(rows[0])) return new MotivationSettings();
        try { return JsonSerializer.Deserialize<MotivationSettings>(rows[0], JsonOptions.Default) ?? new MotivationSettings(); }
        catch (JsonException) { return new MotivationSettings(); }
    }

    public async Task<MotivationSettings> SetSettingsAsync(MotivationSettings s)
    {
        ValidateNorm(s.Storage, "хранения");
        ValidateNorm(s.Kdk, "КДК");
        if (s.BaseHours <= 0 || s.BaseHours > 24) throw new ArgumentException("Базовые часы должны быть от 0 до 24");
        if (s.RoundStep <= 0 || s.RoundStep > s.BaseHours) throw new ArgumentException("Некорректный шаг округления");
        if (s.MaxHours < s.BaseHours || s.MaxHours > 24) throw new ArgumentException("Максимум часов должен быть не меньше базовых и не больше 24");
        ParseDeadline(s.DayDeadline);
        ParseDeadline(s.NightDeadline);

        var json = JsonSerializer.Serialize(s, JsonOptions.Default);
        await _db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO motivation_settings (key, value) VALUES ({SettingsKey}, {json}) ON CONFLICT (key) DO UPDATE SET value = {json}");
        return await GetSettingsAsync();
    }

    private static void ValidateNorm(MotivationNorm? n, string label)
    {
        if (n == null || n.Tasks <= 0 || n.WeightKg <= 0 || n.TasksPerHour <= 0)
            throw new ArgumentException($"Норма {label}: СЗ, вес и «СЗ за час» должны быть больше нуля");
    }

    private static TimeOnly ParseDeadline(string? value)
    {
        if (!TimeOnly.TryParseExact(value ?? "", "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var t))
            throw new ArgumentException("Срок подачи учёток — в формате ЧЧ:ММ");
        return t;
    }

    // Срок подачи учёток в UTC: время по Москве в день начала смены.
    private static DateTime DeadlineUtc(DateOnly date, string shift, MotivationSettings s)
    {
        var t = ParseDeadline(shift == "night" ? s.NightDeadline : s.DayDeadline);
        return date.ToDateTime(t, DateTimeKind.Utc).AddHours(-MoscowUtcOffsetHours);
    }

    // ─── Люди из акта и их учётки ────────────────────────────────────────────

    public async Task<List<MotivationPersonDto>> ListPeopleAsync(string date, string shift)
    {
        var d = DateOnly.ParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        var rows = await _db.MotivationPeople.AsNoTracking()
            .Where(p => p.ShiftDate == d && p.Shift == shift)
            .OrderBy(p => p.Company).ThenBy(p => p.Fio)
            .ToListAsync();
        return rows.Select(ToDto).ToList();
    }

    public async Task<List<MotivationPersonDto>> AddPeopleAsync(MotivationAddPeopleRequest req)
    {
        ValidateShift(req.Date, req.Shift);
        var d = DateOnly.ParseExact(req.Date!, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        var receivedAt = ParseInstantUtc(req.ReceivedAt) ?? DateTime.UtcNow;
        var input = req.People ?? new();
        if (input.Count == 0) throw new ArgumentException("Список пуст");

        var existing = await _db.MotivationPeople
            .Where(p => p.ShiftDate == d && p.Shift == req.Shift)
            .ToListAsync();
        var takenAccounts = existing.Where(p => p.ExecutorId != "")
            .ToDictionary(p => p.ExecutorId, p => p.Fio);

        var added = new List<MotivationPersonEntity>();
        foreach (var p in input)
        {
            var fio = Clean(p.Fio);
            if (fio == "") throw new ArgumentException("У каждой строки должно быть ФИО");
            var executorId = Clean(p.ExecutorId);
            if (executorId != "")
            {
                if (takenAccounts.TryGetValue(executorId, out var owner))
                    throw new ArgumentException($"Учётка {Clean(p.ExecutorName)} ({executorId}) уже закреплена за «{owner}» в эту смену");
                takenAccounts[executorId] = fio;
            }
            var entity = new MotivationPersonEntity
            {
                ShiftDate = d,
                Shift = req.Shift!,
                Company = Clean(p.Company),
                Fio = fio,
                Role = NormalizeRole(p.Role),
                ExecutorId = executorId,
                ExecutorName = Clean(p.ExecutorName),
                // Время получения — только если учётка указана: человек без
                // учётки ещё ничего «не подал».
                ReceivedAt = !req.FromStats && (executorId != "" || Clean(p.ExecutorName) != "") ? receivedAt : null,
                CreatedAt = DateTime.UtcNow,
            };
            _db.MotivationPeople.Add(entity);
            added.Add(entity);
        }
        await _db.SaveChangesAsync();
        return added.Select(ToDto).ToList();
    }

    public async Task<MotivationPersonDto?> UpdatePersonAsync(long id, MotivationUpdatePersonRequest req)
    {
        var entity = await _db.MotivationPeople.FirstOrDefaultAsync(p => p.Id == id);
        if (entity == null) return null;

        if (req.Fio != null)
        {
            var fio = Clean(req.Fio);
            if (fio == "") throw new ArgumentException("ФИО обязательно");
            entity.Fio = fio;
        }
        if (req.Company != null) entity.Company = Clean(req.Company);
        if (req.Role != null) entity.Role = NormalizeRole(req.Role);

        if (req.ExecutorId != null || req.ExecutorName != null)
        {
            var executorId = Clean(req.ExecutorId);
            var executorName = Clean(req.ExecutorName);
            var accountChanged = executorId != entity.ExecutorId || executorName != entity.ExecutorName;
            if (executorId != "" && executorId != entity.ExecutorId)
            {
                var owner = await _db.MotivationPeople.AsNoTracking()
                    .Where(p => p.ShiftDate == entity.ShiftDate && p.Shift == entity.Shift && p.ExecutorId == executorId && p.Id != id)
                    .Select(p => p.Fio)
                    .FirstOrDefaultAsync();
                if (owner != null) throw new ArgumentException($"Учётка {executorName} ({executorId}) уже закреплена за «{owner}» в эту смену");
            }
            entity.ExecutorId = executorId;
            entity.ExecutorName = executorName;
            // Новая учётка — новое время получения (если явно не передано):
            // иначе учётку, выданную в 14:00, можно было бы «подставить» в
            // строку, созданную до срока, и она прошла бы как своевременная.
            if (accountChanged && req.ReceivedAt == null)
                entity.ReceivedAt = executorId != "" || executorName != "" ? DateTime.UtcNow : null;
        }
        if (req.ReceivedAt != null)
            entity.ReceivedAt = req.ReceivedAt == "" ? null : ParseInstantUtc(req.ReceivedAt);

        await _db.SaveChangesAsync();
        return ToDto(entity);
    }

    public async Task<bool> DeletePersonAsync(long id)
    {
        var entity = await _db.MotivationPeople.FirstOrDefaultAsync(p => p.Id == id);
        if (entity == null) return false;
        _db.MotivationPeople.Remove(entity);
        await _db.SaveChangesAsync();
        return true;
    }

    // ─── Расчёт ──────────────────────────────────────────────────────────────

    // Вес одного вида отбора (хранение или КДК) по учётке. Отборы товаров без
    // веса в справочнике досчитываются средним весом отбора этой же учётки
    // (а если у неё нет ни одного отбора с весом — средним по складу за
    // смену), чтобы дыра в справочнике не срезала часы работнику.
    private class WeightPart
    {
        public decimal Grams;        // по справочнику
        public int WeightedItems;    // отборов с весом
        public int MissingItems;     // отборов без веса
        public decimal EstimatedGrams;

        public void Estimate(decimal shiftAvgGramsPerItem)
        {
            if (MissingItems == 0) return;
            var avg = WeightedItems > 0 ? Grams / WeightedItems : shiftAvgGramsPerItem;
            EstimatedGrams = avg * MissingItems;
        }

        public decimal Total => Grams + EstimatedGrams;
    }

    private class AccountStats
    {
        public string ExecutorId = "";
        public string Name = "";
        public int StorageTasks;
        public HashSet<string> KdkKeys = new();
        public WeightPart Storage = new();
        public WeightPart Kdk = new();
        public int MissingWeight => Storage.MissingItems + Kdk.MissingItems;
        public decimal EstimatedGrams => Storage.EstimatedGrams + Kdk.EstimatedGrams;
    }

    private async Task<Dictionary<string, AccountStats>> LoadAccountStatsAsync(string date, string shift)
    {
        var items = await _stats.GetDateItemsAsync(date, null, null, shift);
        var weightMap = await _stats.GetWeightMapAsync();
        var byAccount = new Dictionary<string, AccountStats>();

        foreach (var item in items)
        {
            var type = (item.OperationType ?? "").ToUpperInvariant();
            var isKdk = type == "PICK_BY_LINE";
            var isStorage = type == "PIECE_SELECTION_PICKING";
            if (!isKdk && !isStorage) continue;
            var executorId = item.ExecutorId ?? "";
            if (executorId == "" || item.CompletedAt == null) continue;

            if (!byAccount.TryGetValue(executorId, out var acc))
            {
                acc = new AccountStats { ExecutorId = executorId, Name = Clean(item.Executor) != "" ? Clean(item.Executor) : executorId };
                byAccount[executorId] = acc;
            }

            if (isStorage) acc.StorageTasks++;
            else
            {
                var hour = item.CompletedAt.Value.AddHours(MoscowUtcOffsetHours).Hour;
                var product = !string.IsNullOrEmpty(item.NomenclatureCode) ? item.NomenclatureCode
                    : (!string.IsNullOrEmpty(item.ProductName) ? item.ProductName : "no-product");
                var cell = !string.IsNullOrEmpty(item.Cell) ? item.Cell : "no-target-cell";
                acc.KdkKeys.Add($"{hour}|{product}||{cell}");
            }

            var part = isKdk ? acc.Kdk : acc.Storage;
            var article = (item.NomenclatureCode ?? "").Trim();
            if (string.IsNullOrEmpty(item.ProductName) || article == ""
                || !weightMap.TryGetValue(article, out var gramsPerUnit) || gramsPerUnit <= 0)
            {
                part.MissingItems++;
                continue;
            }
            part.Grams += gramsPerUnit * Math.Max(1, item.Quantity ?? 1);
            part.WeightedItems++;
        }

        decimal ShiftAvg(Func<AccountStats, WeightPart> pick)
        {
            var parts = byAccount.Values.Select(pick).ToList();
            var items = parts.Sum(p => p.WeightedItems);
            return items > 0 ? parts.Sum(p => p.Grams) / items : 0;
        }
        var storageAvg = ShiftAvg(a => a.Storage);
        var kdkAvg = ShiftAvg(a => a.Kdk);
        foreach (var acc in byAccount.Values)
        {
            acc.Storage.Estimate(storageAvg);
            acc.Kdk.Estimate(kdkAvg);
        }
        return byAccount;
    }

    public async Task<object> CalculateAsync(string date, string shift)
    {
        ValidateShift(date, shift);
        var settings = await GetSettingsAsync();
        var d = DateOnly.ParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        var deadline = DeadlineUtc(d, shift, settings);

        var people = await _db.MotivationPeople.AsNoTracking()
            .Where(p => p.ShiftDate == d && p.Shift == shift)
            .OrderBy(p => p.Company).ThenBy(p => p.Fio)
            .ToListAsync();
        var accounts = await LoadAccountStatsAsync(date, shift);
        var idByName = new Dictionary<string, string>();
        foreach (var acc in accounts.Values) idByName.TryAdd(NormName(acc.Name), acc.ExecutorId);

        var usedAccounts = new HashSet<string>();
        var rows = new List<MotivationResultRow>();
        foreach (var p in people)
        {
            var row = new MotivationResultRow
            {
                Id = p.Id,
                Company = p.Company,
                Fio = p.Fio,
                Role = p.Role,
                ExecutorId = p.ExecutorId,
                ExecutorName = p.ExecutorName,
                ReceivedAt = p.ReceivedAt.HasValue ? DateTime.SpecifyKind(p.ReceivedAt.Value, DateTimeKind.Utc).ToString("o") : null,
            };
            rows.Add(row);

            // Учётка может быть задана только именем (не нашлась в
            // справочнике сотрудников) — тогда ищем по имени исполнителя в WMS.
            var accountId = p.ExecutorId;
            if (accountId == "" && p.ExecutorName != "" && idByName.TryGetValue(NormName(p.ExecutorName), out var byName))
                accountId = byName;
            AccountStats? acc = null;
            if (accountId != "" && accounts.TryGetValue(accountId, out var found))
            {
                acc = found;
                usedAccounts.Add(accountId);
                row.ExecutorId = accountId;
                if (row.ExecutorName == "") row.ExecutorName = found.Name;
                FillStats(row, found);
            }

            if (p.Role == MotivationRoles.Other)
            {
                row.Status = MotivationStatuses.NoNorm;
                row.Hours = settings.BaseHours;
                continue;
            }
            if (p.ExecutorId == "" && p.ExecutorName == "")
            {
                row.Status = MotivationStatuses.NoAccount;
                continue;
            }
            row.Late = p.ReceivedAt.HasValue && p.ReceivedAt.Value > deadline;
            if (row.Late && settings.StrictDeadline)
            {
                row.Status = MotivationStatuses.Late;
                continue;
            }
            if (acc == null || row.StorageTasks + row.KdkTasks == 0)
            {
                row.Status = MotivationStatuses.NoStats;
                continue;
            }
            ApplyNorm(row, acc, settings);
        }

        var unmapped = accounts.Values
            .Where(a => !usedAccounts.Contains(a.ExecutorId))
            .OrderBy(a => a.Name)
            .ToList();
        var idMap = unmapped.Count > 0 ? await _stats.GetIdMapAsync() : new Dictionary<string, string>();
        // Учётки с отбором, которых нет в актах: норма считается и по ним
        // (учётка = человек, компания — из справочника сотрудников). Так
        // можно разбирать прошлые смены, не внося акты задним числом.
        var unmappedOut = unmapped.Select(a =>
        {
            var row = new MotivationResultRow
            {
                ExecutorId = a.ExecutorId,
                ExecutorName = a.Name,
                Fio = a.Name,
                Role = MotivationRoles.Picker,
                Company = idMap.TryGetValue(a.ExecutorId, out var c) && c != "" ? c : "—",
            };
            FillStats(row, a);
            if (row.StorageTasks + row.KdkTasks > 0) ApplyNorm(row, a, settings);
            else row.Status = MotivationStatuses.NoStats;
            return row;
        }).OrderBy(r => r.Company).ThenBy(r => r.Fio).ToList();

        return new
        {
            ok = true,
            date,
            shift,
            deadline = DateTime.SpecifyKind(deadline, DateTimeKind.Utc).ToString("o"),
            settings,
            rows,
            unmapped = unmappedOut,
        };
    }

    // Вес — с учётом оценки для отборов без веса в справочнике (WeightPart).
    private static void FillStats(MotivationResultRow row, AccountStats acc)
    {
        row.StorageTasks = acc.StorageTasks;
        row.KdkTasks = acc.KdkKeys.Count;
        row.StorageWeightKg = Math.Round((double)acc.Storage.Total / 1000, 1);
        row.KdkWeightKg = Math.Round((double)acc.Kdk.Total / 1000, 1);
        row.MissingWeightItems = acc.MissingWeight;
        row.EstimatedWeightKg = Math.Round((double)acc.EstimatedGrams / 1000, 1);
    }

    private static void ApplyNorm(MotivationResultRow row, AccountStats acc, MotivationSettings s)
    {
        var storageShare = row.StorageTasks / s.Storage.Tasks;
        var kdkShare = row.KdkTasks / s.Kdk.Tasks;
        var tasksPct = storageShare + kdkShare;
        var weightPct = (double)acc.Storage.Total / 1000 / s.Storage.WeightKg + (double)acc.Kdk.Total / 1000 / s.Kdk.WeightKg;
        var pct = Math.Min(tasksPct, weightPct);

        // Сколько часов «стоит» вся норма: хранение 900/100 = 9 ч, КДК
        // 1500/200 = 7,5 ч; при смешанной работе — пропорционально долям.
        var hoursPerNorm = (row.StorageTasks / s.Storage.TasksPerHour + row.KdkTasks / s.Kdk.TasksPerHour) / tasksPct;
        var rawDelta = (pct - 1) * hoursPerNorm;
        var steps = Math.Truncate(Math.Round(rawDelta / s.RoundStep, 6));
        var delta = steps * s.RoundStep;
        if (!s.BonusEnabled && delta > 0) delta = 0;

        var hours = Math.Clamp(s.BaseHours + delta, 0, Math.Max(s.BaseHours, s.MaxHours));
        row.TasksPct = Math.Round(tasksPct, 4);
        row.WeightPct = Math.Round(weightPct, 4);
        row.Pct = Math.Round(pct, 4);
        row.Hours = hours;
        row.DeltaHours = hours - s.BaseHours;
        row.Status = row.DeltaHours < 0 ? MotivationStatuses.Under
            : row.DeltaHours > 0 ? MotivationStatuses.Over
            : MotivationStatuses.Done;
    }
}
