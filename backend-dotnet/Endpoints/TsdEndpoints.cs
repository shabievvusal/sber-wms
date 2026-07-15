using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Перенос /api/tsd-assignments*, /api/tsd-settings из server.js — все 6
// маршрутов требуют сессию (vsSessionRequired в оригинале), без исключений.
public static class TsdEndpoints
{
    public static void MapTsdEndpoints(this WebApplication app)
    {
        app.MapGet("/api/tsd-assignments", async (TsdService svc) =>
        {
            try
            {
                var assignments = await svc.ListActiveAsync();
                var settings = await svc.GetSettingsAsync();
                return Results.Json(new { assignments, settings });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/tsd-assignments/assign", async (TsdAssignRequest body, TsdService svc) =>
        {
            try
            {
                var assignment = await svc.AssignAsync(body);
                var assignments = await svc.ListActiveAsync();
                var settings = await svc.GetSettingsAsync();
                return Results.Json(new { ok = true, assignment, assignments, settings });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/tsd-assignments/return", async (TsdReturnByExecutorRequest body, TsdService svc) =>
        {
            try
            {
                var assignment = await svc.ReturnByExecutorAsync(body.ExecutorId);
                var assignments = await svc.ListActiveAsync();
                var settings = await svc.GetSettingsAsync();
                return Results.Json(new { ok = true, assignment, assignments, settings });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/tsd-assignments/return-tsd", async (TsdReturnByTsdRequest body, TsdService svc) =>
        {
            try
            {
                var (assignment, foreignReturn) = await svc.ReturnByTsdAsync(body);
                var assignments = await svc.ListActiveAsync();
                var settings = await svc.GetSettingsAsync();
                return Results.Json(new { ok = true, assignment, foreignReturn, assignments, settings });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapGet("/api/tsd-settings", async (TsdService svc) =>
        {
            try { return Results.Json(await svc.GetSettingsAsync()); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPut("/api/tsd-settings", async (TsdSettingsRequest body, TsdService svc) =>
        {
            try
            {
                var settings = await svc.SetSettingsAsync(body);
                return Results.Json(new { ok = true, totalCount = settings.TotalCount });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // Сотрудники без executorId, заводятся вручную в Настройках
        // исключительно для выдачи ТСД — не пересекаются с /api/employees
        // (та таблица требует executorId и участвует в статистике/
        // мониторинге, эта — нет, см. TsdModels.cs/TsdService.cs).
        app.MapGet("/api/tsd/manual-employees", async (TsdService svc) =>
        {
            try { return Results.Json(new { ok = true, employees = await svc.ListManualEmployeesAsync() }); }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/tsd/manual-employees", async (TsdManualEmployeeRequest body, TsdService svc) =>
        {
            try
            {
                var employee = await svc.AddManualEmployeeAsync(body);
                return Results.Json(new { ok = true, employee });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPut("/api/tsd/manual-employees/{id}", async (string id, TsdManualEmployeeRequest body, TsdService svc) =>
        {
            try
            {
                var employee = await svc.UpdateManualEmployeeAsync(id, body);
                if (employee == null) return Results.Json(new { ok = false, error = "Сотрудник не найден" }, statusCode: 404);
                return Results.Json(new { ok = true, employee });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapDelete("/api/tsd/manual-employees/{id}", async (string id, TsdService svc) =>
        {
            var deleted = await svc.DeleteManualEmployeeAsync(id);
            return Results.Json(new { ok = deleted });
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
