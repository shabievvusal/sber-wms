using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Перенос empl-pg.js — только чистые CRUD-операции над таблицей employees.
// GET /api/empl/find-unregistered, POST /api/empl/enrich-names,
// POST /api/empl/upgrade-fio-ids остались на Node (см. PLAN.md): они
// сканируют локальные файлы (data/*/HH.json, names_registry.json, raw_tmp/),
// которых у dotnet-контейнера нет (не смонтированы, см. docker-compose.yml) —
// тот же приём, что и с /api/rk/routes/*/eos/request-refresh в Фазе 1
// (эндпоинт остаётся на стороне, которая владеет нужным ей локальным
// состоянием).
public class EmployeeService
{
    private readonly AppDbContext _db;

    public EmployeeService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<EmployeesListResponse> ListEmployeesAsync()
    {
        var rows = await _db.Employees.AsNoTracking().OrderBy(e => e.Fio).ToListAsync();
        var employees = rows.Select(r => new Employee
        {
            ExecutorId = r.ExecutorId,
            Fio = r.Fio,
            Company = r.Company ?? "",
            Phone = r.Phone ?? "",
            Password = r.Password ?? "",
        }).ToList();
        var companies = employees.Select(e => e.Company).Where(c => !string.IsNullOrEmpty(c)).Distinct().OrderBy(c => c).ToList();
        return new EmployeesListResponse { Employees = employees, Companies = companies };
    }

    public async Task UpsertEmployeeAsync(EmployeeUpsertRequest req)
    {
        var id = (req.ExecutorId ?? "").Trim();
        var fio = (req.Fio ?? "").Trim();
        var company = (req.Company ?? "").Trim();
        var phone = (req.Phone ?? "").Trim();
        var password = (req.Password ?? "").Trim();
        if (id == "") throw new ArgumentException("executorId обязателен для сохранения сотрудника");
        if (fio == "") throw new ArgumentException("ФИО обязательно");

        await _db.Database.ExecuteSqlInterpolatedAsync($@"
            INSERT INTO employees (executor_id, fio, company, phone, password)
            VALUES ({id}, {fio}, {company}, {phone}, {password})
            ON CONFLICT (executor_id) DO UPDATE SET fio = {fio}, company = {company}, phone = {phone}, password = {password}");
    }

    public async Task<int> AddNewEmployeesAsync(EmployeeAddNewRequest req)
    {
        var candidates = req.Executors ?? (req.Names?.Select(n => new NewEmployeeCandidate { Fio = n }).ToList()) ?? new List<NewEmployeeCandidate>();
        if (candidates.Count == 0) return 0;

        var existingIds = new HashSet<string>(await _db.Employees.Select(e => e.ExecutorId).ToListAsync());

        var added = 0;
        foreach (var c in candidates)
        {
            var id = (c.ExecutorId ?? "").Trim();
            var fio = (c.Fio ?? "").Trim();
            if (fio == "" || id == "") continue;
            if (existingIds.Contains(id)) continue;
            await _db.Database.ExecuteSqlInterpolatedAsync($@"
                INSERT INTO employees (executor_id, fio, company) VALUES ({id}, {fio}, '')
                ON CONFLICT (executor_id) DO NOTHING");
            existingIds.Add(id);
            added++;
        }
        return added;
    }

    public async Task SaveAllAsync(List<EmployeeUpsertRequest> employees)
    {
        await using var tx = await _db.Database.BeginTransactionAsync();
        await _db.Database.ExecuteSqlRawAsync("TRUNCATE employees");
        foreach (var e in employees)
        {
            var id = (e.ExecutorId ?? "").Trim();
            var fio = (e.Fio ?? "").Trim();
            var company = (e.Company ?? "").Trim();
            var phone = (e.Phone ?? "").Trim();
            var password = (e.Password ?? "").Trim();
            if (fio == "" || id == "") continue;
            await _db.Database.ExecuteSqlInterpolatedAsync($@"
                INSERT INTO employees (executor_id, fio, company, phone, password)
                VALUES ({id}, {fio}, {company}, {phone}, {password})
                ON CONFLICT (executor_id) DO UPDATE SET fio = {fio}, company = {company}, phone = {phone}, password = {password}");
        }
        await tx.CommitAsync();
    }

    // Парсинг CSV-текста fio;company;phone;password — совместимость со старым форматом POST /api/employees.
    public static List<EmployeeUpsertRequest> ParseCsv(string csv)
    {
        var result = new List<EmployeeUpsertRequest>();
        foreach (var rawLine in csv.Replace("\r\n", "\n").Split('\n'))
        {
            var t = rawLine.Trim();
            if (t == "") continue;
            var cols = t.Split(';').Select(v => v.Trim()).ToArray();
            var fio = cols.Length > 0 ? cols[0] : "";
            if (fio == "") continue;
            result.Add(new EmployeeUpsertRequest
            {
                Fio = fio,
                Company = cols.Length > 1 ? cols[1] : "",
                Phone = cols.Length > 2 ? cols[2] : "",
                Password = cols.Length > 3 ? cols[3] : "",
            });
        }
        return result;
    }
}
