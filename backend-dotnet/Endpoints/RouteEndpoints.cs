using Microsoft.AspNetCore.Mvc;
using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Порт CRUD/поисковых роутов /api/rk/* из server.js (routes, routes/:id,
// routes/bulk, import-bulk, routes-search). Пути/методы/JSON — 1-в-1 с Node.
public static class RouteEndpoints
{
    public static void MapRouteEndpoints(this WebApplication app)
    {
        // DELETE /api/rk/routes/bulk — тело запроса на DELETE (как и в Express-оригинале)
        app.MapDelete("/api/rk/routes/bulk", async ([FromBody] DeleteBulkRequest body, RouteService svc) =>
        {
            try
            {
                var ids = body.Ids;
                if (ids == null || ids.Count == 0) return Results.BadRequest(new { error = "Нужен массив ids" });
                var deleted = await svc.DeleteRoutesByIdsAsync(ids);
                return Results.Json(new { ok = true, deleted });
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // DELETE /api/rk/routes?dateFrom=&dateTo=
        app.MapDelete("/api/rk/routes", async (string? dateFrom, string? dateTo, RouteService svc) =>
        {
            try
            {
                if (string.IsNullOrEmpty(dateFrom) || string.IsNullOrEmpty(dateTo))
                    return Results.BadRequest(new { error = "Нужны dateFrom и dateTo" });
                var deleted = await svc.DeleteRoutesByDateRangeAsync(dateFrom, dateTo);
                return Results.Json(new { ok = true, deleted });
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // GET /api/rk/routes?q=&dateFrom=&dateTo=&receivedDateFrom=&receivedDateTo=&status=
        app.MapGet("/api/rk/routes", async (string? q, string? dateFrom, string? dateTo, string? receivedDateFrom, string? receivedDateTo, string? status, RouteService svc) =>
        {
            try
            {
                return Results.Json(await svc.GetRoutesAsync(q, dateFrom, dateTo, receivedDateFrom, receivedDateTo, status));
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // GET /api/rk/routes/:routeId
        app.MapGet("/api/rk/routes/{routeId}", async (string routeId, RouteService svc) =>
        {
            try
            {
                var route = await svc.GetRouteByIdAsync(Uri.UnescapeDataString(routeId));
                if (route == null) return Results.NotFound(new { error = "Маршрут не найден" });
                return Results.Json(route);
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // POST /api/rk/import-bulk
        app.MapPost("/api/rk/import-bulk", async (ImportBulkRequest body, RouteService svc) =>
        {
            try
            {
                var routes = body.Routes ?? new();
                if (routes.Count == 0) return Results.BadRequest(new { ok = false, error = "Нет маршрутов" });
                var (added, updated) = await svc.ImportBulkAsync(routes);
                return Results.Json(new { ok = true, routes = routes.Count, added, updated });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 500);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // GET /api/rk/routes-search?q=&mode=unshipped|pending — публичный (страница кладовщика)
        app.MapGet("/api/rk/routes-search", async (string? q, string? mode, RouteService svc) =>
        {
            try
            {
                return Results.Json(await svc.SearchRoutesAsync(q, mode));
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        });
    }
}
