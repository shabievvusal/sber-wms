using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Мотивация аутсорса (2026-09-25), см. MotivationService.cs. Всё под
// сессией; нормы меняют только admin/developer.
public static class MotivationEndpoints
{
    public static void MapMotivationEndpoints(this WebApplication app)
    {
        app.MapGet("/api/motivation/settings", async (MotivationService svc) =>
        {
            try { return Results.Json(new { ok = true, settings = await svc.GetSettingsAsync() }); }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPut("/api/motivation/settings", async (MotivationSettings body, MotivationService svc) =>
        {
            try { return Results.Json(new { ok = true, settings = await svc.SetSettingsAsync(body) }); }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapGet("/api/motivation/people", async (string? date, string? shift, MotivationService svc) =>
        {
            try
            {
                MotivationService.ValidateShift(date, shift);
                return Results.Json(new { ok = true, people = await svc.ListPeopleAsync(date!, shift!) });
            }
            catch (ArgumentException err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/motivation/people", async (MotivationAddPeopleRequest body, MotivationService svc) =>
        {
            try { return Results.Json(new { ok = true, people = await svc.AddPeopleAsync(body) }); }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPut("/api/motivation/people/{id:long}", async (long id, MotivationUpdatePersonRequest body, MotivationService svc) =>
        {
            try
            {
                var person = await svc.UpdatePersonAsync(id, body);
                if (person == null) return Results.Json(new { ok = false, error = "Запись не найдена" }, statusCode: 404);
                return Results.Json(new { ok = true, person });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapDelete("/api/motivation/people/{id:long}", async (long id, MotivationService svc) =>
        {
            var deleted = await svc.DeletePersonAsync(id);
            return Results.Json(new { ok = deleted });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapGet("/api/motivation/calculate", async (string? date, string? shift, MotivationService svc) =>
        {
            try
            {
                MotivationService.ValidateShift(date, shift);
                return Results.Json(await svc.CalculateAsync(date!, shift!));
            }
            catch (ArgumentException err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
