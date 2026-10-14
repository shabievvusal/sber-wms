using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Перенос части /api/empl* + /api/employees из server.js — только чистые
// CRUD над таблицей employees (без сессии, как и в оригинале). Роуты,
// зависящие от локальных файлов Node (find-unregistered, enrich-names,
// upgrade-fio-ids), остались на Node — см. Services/EmployeeService.cs.
public static class EmployeeEndpoints
{
    public static void MapEmployeeEndpoints(this WebApplication app)
    {
        // ─── Проверка учёток ТСД (см. Services/AccountCheckService.cs) ─────────
        // В отличие от остального CRUD сотрудников — только для вошедших на сайт
        // администраторов: проверка выполняет реальные входы в WMS.
        app.MapGet("/api/empl/account-checks", async (AccountCheckService svc) =>
        {
            try { return Results.Json(new { ok = true, checks = await svc.ListAsync() }); }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // Сайт шлёт пачками (до 25 за раз) и показывает прогресс — так длинный
        // список не упирается в таймауты прокси.
        app.MapPost("/api/empl/account-check", async (AccountCheckRequest body, AccountCheckService svc, HttpContext ctx) =>
        {
            try
            {
                var ids = (body.ExecutorIds ?? new List<string>()).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
                if (ids.Count == 0) return Results.Json(new { ok = false, error = "Не выбраны сотрудники" }, statusCode: 400);
                if (ids.Count > 25) return Results.Json(new { ok = false, error = "Не больше 25 сотрудников за один запрос" }, statusCode: 400);
                var results = await svc.CheckAsync(ids, ctx.RequestAborted);
                return Results.Json(new { ok = true, results });
            }
            catch (OperationCanceledException) { return Results.Json(new { ok = false, error = "Проверка прервана" }, statusCode: 499); }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapGet("/api/empl", async (EmployeeService svc) =>
        {
            try { return Results.Json(await svc.ListEmployeesAsync()); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapPost("/api/empl", async (EmployeeUpsertRequest body, EmployeeService svc) =>
        {
            try
            {
                if (string.IsNullOrWhiteSpace(body.Fio)) return Results.Json(new { ok = false, error = "Укажите ФИО" }, statusCode: 400);
                if (string.IsNullOrWhiteSpace(body.ExecutorId)) return Results.Json(new { ok = false, error = "executorId обязателен" }, statusCode: 400);
                await svc.UpsertEmployeeAsync(body);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        app.MapPost("/api/empl/add-new", async (EmployeeAddNewRequest body, EmployeeService svc) =>
        {
            try
            {
                var added = await svc.AddNewEmployeesAsync(body);
                var data = await svc.ListEmployeesAsync();
                return Results.Json(new { ok = true, added, employees = data.Employees, companies = data.Companies });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/employees", async (EmployeeService svc) =>
        {
            try
            {
                var data = await svc.ListEmployeesAsync();
                return Results.Json(new { csv = "", employees = data.Employees, companies = data.Companies });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapPost("/api/employees", async (EmployeeSaveAllRequest body, EmployeeService svc) =>
        {
            try
            {
                List<EmployeeUpsertRequest>? employees = body.Employees;
                if (employees == null && body.Csv != null) employees = EmployeeService.ParseCsv(body.Csv);
                if (employees == null) return Results.Json(new { error = "Нет данных" }, statusCode: 400);

                await svc.SaveAllAsync(employees);
                var data = await svc.ListEmployeesAsync();
                return Results.Json(new { ok = true, employees = data.Employees, companies = data.Companies });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });
    }
}
