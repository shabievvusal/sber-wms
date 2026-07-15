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
