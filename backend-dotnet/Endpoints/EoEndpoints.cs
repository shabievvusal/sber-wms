using System.Text.Json;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// GET .../eos, GET /api/rk/eo-refresh-targets и POST .../eos/refresh —
// публичные (кладовщик/киоск), без сессии, как и в оригинале. Ручной
// eos/request-refresh (in-memory очередь на Node) убран 2026-09-06: списки ЕО
// обновляет фоном устройство с автообновлением, так что весь /api/rk/* теперь
// приходит сюда (см. Caddyfile).
public static class EoEndpoints
{
    public static void MapEoEndpoints(this WebApplication app)
    {
        app.MapGet("/api/rk/routes/{routeId}/eos", async (string routeId, RouteService svc) =>
        {
            try
            {
                var eos = await svc.GetRouteEosAsync(Uri.UnescapeDataString(routeId));
                if (eos == null) return Results.NotFound(new { error = "Маршрут не найден" });
                return Results.Json(eos);
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        });

        // Что обновлять фоном — публичный (его дёргает то же устройство с
        // автообновлением, что и остальные ЕО-эндпоинты, без сессии).
        app.MapGet("/api/rk/eo-refresh-targets", async (int? days, RouteService svc) =>
        {
            try
            {
                return Results.Json(await svc.GetEoRefreshTargetsAsync(days is > 0 and <= 30 ? days.Value : 2));
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        });

        app.MapPost("/api/rk/routes/{routeId}/eos/refresh", async (string routeId, JsonElement body, RouteService svc) =>
        {
            try
            {
                var routeVal = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("value", out var v) ? v : body;
                var stores = routeVal.ValueKind == JsonValueKind.Object && routeVal.TryGetProperty("stores", out var s) && s.ValueKind == JsonValueKind.Array
                    ? s
                    : default;
                var results = await svc.UpdateRouteEosBatchAsync(Uri.UnescapeDataString(routeId), stores);
                return Results.Json(new { ok = true, results });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 500);
            }
        });
    }
}
