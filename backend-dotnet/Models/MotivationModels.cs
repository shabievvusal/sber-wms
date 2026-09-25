namespace BackendDotnet.Models;

// Мотивация аутсорса (2026-09-25). Таблицы motivation_people/
// motivation_settings создаёт Node (backend/motivation-pg.js init()).

public class MotivationPersonEntity
{
    public long Id { get; set; }
    public DateOnly ShiftDate { get; set; }
    public string Shift { get; set; } = "";
    public string Company { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Role { get; set; } = MotivationRoles.Picker;
    public string ExecutorId { get; set; } = "";
    public string ExecutorName { get; set; } = "";
    public DateTime? ReceivedAt { get; set; }
    public DateTime CreatedAt { get; set; }
}

public static class MotivationRoles
{
    // Комплектовщик — к нему применяется норма. Прочие (грузчик, заморозка
    // и т.п.) — полные часы смены, СЗ у них нет.
    public const string Picker = "picker";
    public const string Other = "other";
}

// Норма одного вида отбора: СЗ + вес за смену и «сколько СЗ = 1 час».
public class MotivationNorm
{
    public double Tasks { get; set; }
    public double WeightKg { get; set; }
    public double TasksPerHour { get; set; }
}

public class MotivationSettings
{
    public double BaseHours { get; set; } = 10.5;
    public MotivationNorm Storage { get; set; } = new() { Tasks = 900, WeightKg = 2500, TasksPerHour = 100 };
    public MotivationNorm Kdk { get; set; } = new() { Tasks = 1500, WeightKg = 1200, TasksPerHour = 200 };
    // Шаг округления часов. Недобор округляется в пользу работника
    // (0,5 ч снимается только за полные 50 СЗ хранения), перевыполнение —
    // в пользу склада.
    public double RoundStep { get; set; } = 0.5;
    public bool BonusEnabled { get; set; } = true;
    public double MaxHours { get; set; } = 12;
    public string DayDeadline { get; set; } = "10:00";
    public string NightDeadline { get; set; } = "22:00";
    // true — учётка, полученная после срока, не засчитывается (0 часов).
    public bool StrictDeadline { get; set; } = true;
}

public class MotivationPersonDto
{
    public long Id { get; set; }
    public string Date { get; set; } = "";
    public string Shift { get; set; } = "";
    public string Company { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Role { get; set; } = "";
    public string ExecutorId { get; set; } = "";
    public string ExecutorName { get; set; } = "";
    public string? ReceivedAt { get; set; }
}

public class MotivationPersonInput
{
    public string? Company { get; set; }
    public string? Fio { get; set; }
    public string? Role { get; set; }
    public string? ExecutorId { get; set; }
    public string? ExecutorName { get; set; }
}

public class MotivationAddPeopleRequest
{
    public string? Date { get; set; }
    public string? Shift { get; set; }
    // ISO-время получения списка от подрядчика; пусто — «сейчас».
    public string? ReceivedAt { get; set; }
    // true — люди взяты из статистики (учётки от подрядчика не получены):
    // время получения не ставится, срок подачи на них не распространяется.
    public bool FromStats { get; set; }
    public List<MotivationPersonInput>? People { get; set; }
}

public class MotivationUpdatePersonRequest
{
    public string? Company { get; set; }
    public string? Fio { get; set; }
    public string? Role { get; set; }
    public string? ExecutorId { get; set; }
    public string? ExecutorName { get; set; }
    public string? ReceivedAt { get; set; }
}

public static class MotivationStatuses
{
    public const string Done = "done";            // норма выполнена ровно / в пределах шага
    public const string Under = "under";          // недобор, часы сняты
    public const string Over = "over";            // перевыполнение, часы добавлены
    public const string NoAccount = "no_account"; // учётку не дали
    public const string Late = "late";            // учётку дали после срока
    public const string NoStats = "no_stats";     // под учёткой нет отбора в смену
    public const string NoNorm = "no_norm";       // не комплектовщик — полные часы
}

public class MotivationResultRow
{
    public long Id { get; set; }
    public string Company { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Role { get; set; } = "";
    public string ExecutorId { get; set; } = "";
    public string ExecutorName { get; set; } = "";
    public string? ReceivedAt { get; set; }
    public bool Late { get; set; }
    public int StorageTasks { get; set; }
    public int KdkTasks { get; set; }
    public double StorageWeightKg { get; set; }
    public double KdkWeightKg { get; set; }
    // Отборы товаров без веса в справочнике — их вес не посчитан, и недобор
    // по весу может быть не по вине работника (Статистика → «Нет веса»).
    public int MissingWeightItems { get; set; }
    // Доли нормы (1 = 100%). Для смешанной работы складываются:
    // 450 СЗ хранения + 750 СЗ КДК = 0,5 + 0,5 = 100%.
    public double TasksPct { get; set; }
    public double WeightPct { get; set; }
    public double Pct { get; set; }
    public double DeltaHours { get; set; }
    public double Hours { get; set; }
    public string Status { get; set; } = "";
}
