namespace BackendDotnet.Models;

// EF-сущность на существующую таблицу tsd_assignments (создана Node,
// tsd-pg.js init()) — обычные скалярные колонки, JSONB нет вообще.
public class TsdAssignmentEntity
{
    public long Id { get; set; }
    public string ExecutorId { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Company { get; set; } = "";
    public string Tsd { get; set; } = "";
    public DateTime AssignedAt { get; set; }
    public DateTime? ReturnedAt { get; set; }
    public string ReturnedByExecutorId { get; set; } = "";
    public string ReturnedByFio { get; set; } = "";
    public string ReturnedByCompany { get; set; } = "";
}

// Ответ API — аналог toAssignment() из tsd-pg.js (даты как ISO-строки, а не
// объекты, как и в оригинале).
public class TsdAssignment
{
    public long Id { get; set; }
    public string ExecutorId { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Company { get; set; } = "";
    public string Tsd { get; set; } = "";
    public string AssignedAt { get; set; } = "";
    public string? ReturnedAt { get; set; }
    public string ReturnedByExecutorId { get; set; } = "";
    public string ReturnedByFio { get; set; } = "";
    public string ReturnedByCompany { get; set; } = "";
}

public class TsdSettings
{
    public int TotalCount { get; set; }
}

public class TsdAssignRequest
{
    public string? ExecutorId { get; set; }
    public string? Fio { get; set; }
    public string? Company { get; set; }
    public string? Tsd { get; set; }
}

public class TsdReturnByExecutorRequest
{
    public string? ExecutorId { get; set; }
}

public class TsdReturnByTsdRequest
{
    public string? Tsd { get; set; }
    public string? ReturnedByExecutorId { get; set; }
    public string? ReturnedByFio { get; set; }
    public string? ReturnedByCompany { get; set; }
}

public class TsdSettingsRequest
{
    public int TotalCount { get; set; }
}

// EF-сущность на tsd_manual_employees (создана Node, tsd-pg.js init()) —
// сотрудники без executorId, заведённые вручную специально для выдачи ТСД
// (см. комментарий у таблицы). Id — синтетический ("manual-" + hex), никогда
// не пересекается с настоящими WMS executorId.
public class TsdManualEmployeeEntity
{
    public string Id { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Company { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

public class TsdManualEmployee
{
    public string Id { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Company { get; set; } = "";
}

public class TsdManualEmployeeRequest
{
    public string? Fio { get; set; }
    public string? Company { get; set; }
}
