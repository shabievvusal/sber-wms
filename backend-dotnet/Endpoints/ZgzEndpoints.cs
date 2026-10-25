using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// «Поиск потеряшек» — переводы ЕО в ЗГЗ на сервере (ZgzService).
// Загрузка из WMS — в браузере (токен пользователя), сюда — пачками.
public static class ZgzEndpoints
{
    public static void MapZgzEndpoints(this WebApplication app)
    {
        app.MapPost("/api/zgz/save", async (ZgzSaveRequest body, ZgzService svc) =>
        {
            try
            {
                var items = body.Items ?? new();
                var added = await svc.SaveAsync(items);
                return Results.Json(new { ok = true, added, itemsCount = items.Count });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapGet("/api/zgz/moves", async (string? from, string? to, ZgzService svc) =>
        {
            try
            {
                if (!DateTimeOffset.TryParse(from, out var f) || !DateTimeOffset.TryParse(to, out var t))
                    return Results.Json(new { error = "Нужны from и to (ISO)" }, statusCode: 400);
                if (t < f) return Results.Json(new { error = "Конец интервала раньше начала" }, statusCode: 400);
                if (t - f > TimeSpan.FromDays(7)) return Results.Json(new { error = "Интервал не больше 7 дней" }, statusCode: 400);
                return Results.Json(await svc.GetAsync(f.UtcDateTime, t.UtcDateTime));
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapGet("/api/zgz/info", async (ZgzService svc) =>
        {
            try { return Results.Json(await svc.InfoAsync()); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // Очистка (Настройки → Система, admin/developer): по датам перевода
        // (МСК) или всё, если даты не заданы.
        app.MapGet("/api/zgz/count", async (string? dateFrom, string? dateTo, ZgzService svc) =>
        {
            try { return Results.Json(new { rows = await svc.CountAsync(dateFrom, dateTo) }); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapPost("/api/zgz/delete", async (ZgzDeleteRequest body, ZgzService svc) =>
        {
            try { return Results.Json(new { ok = true, deleted = await svc.DeleteAsync(body.DateFrom, body.DateTo) }); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();
    }
}
