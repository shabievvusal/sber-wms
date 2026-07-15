namespace BackendDotnet.Models;

// EF-сущность на существующую таблицу employees (создана Node, empl-pg.js
// init()) — простые скалярные колонки, без JSONB.
public class EmployeeEntity
{
    public string ExecutorId { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Company { get; set; } = "";
    public string Phone { get; set; } = "";
    public string Password { get; set; } = "";
}

public class Employee
{
    public string ExecutorId { get; set; } = "";
    public string Fio { get; set; } = "";
    public string Company { get; set; } = "";
    public string Phone { get; set; } = "";
    public string Password { get; set; } = "";
}

public class EmployeesListResponse
{
    public List<Employee> Employees { get; set; } = new();
    public List<string> Companies { get; set; } = new();
}

public class EmployeeUpsertRequest
{
    public string? ExecutorId { get; set; }
    public string? Fio { get; set; }
    public string? Company { get; set; }
    public string? Phone { get; set; }
    public string? Password { get; set; }
}

public class NewEmployeeCandidate
{
    public string? ExecutorId { get; set; }
    public string? Fio { get; set; }
}

public class EmployeeAddNewRequest
{
    public List<NewEmployeeCandidate>? Executors { get; set; }
    public List<string>? Names { get; set; }
}

public class EmployeeSaveAllRequest
{
    public List<EmployeeUpsertRequest>? Employees { get; set; }
    public string? Csv { get; set; }
}
