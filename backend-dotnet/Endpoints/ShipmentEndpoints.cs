using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Порт отгрузки/приёмки: ship/receive (публичные — кладовщик без сессии),
// PUT ship/receive + confirm-ship/confirm-receive + PATCH driver (требуют
// сессию, confirm-* дополнительно резолвят confirmedBy через vs_users).
public static class ShipmentEndpoints
{
    public static void MapShipmentEndpoints(this WebApplication app)
    {
        // POST /api/rk/routes/:routeId/ship — отгрузка (кладовщик, без сессии)
        app.MapPost("/api/rk/routes/{routeId}/ship", async (string routeId, ShipmentRequest body, RouteService svc, SseService sse) =>
        {
            try
            {
                if (body.Items == null) return Results.BadRequest(new { ok = false, error = "Некорректный формат данных" });
                var route = await svc.SubmitShipmentAsync(Uri.UnescapeDataString(routeId), body);
                await sse.NotifyAsync("routes-updated");
                return Results.Json(new { ok = true, route });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 400);
            }
        });

        // POST /api/rk/routes/:routeId/receive — приёмка возврата РК
        app.MapPost("/api/rk/routes/{routeId}/receive", async (string routeId, ReceivingRequest body, RouteService svc, SseService sse) =>
        {
            try
            {
                if (body.Items == null) return Results.BadRequest(new { ok = false, error = "Некорректный формат данных" });
                var route = await svc.SubmitReceivingAsync(Uri.UnescapeDataString(routeId), body);
                await sse.NotifyAsync("routes-updated");
                return Results.Json(new { ok = true, route });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 400);
            }
        });

        // PATCH /api/rk/routes/:routeId/driver — замена водителя
        app.MapPatch("/api/rk/routes/{routeId}/driver", async (string routeId, DriverUpdateRequest body, RouteService svc) =>
        {
            try
            {
                var route = await svc.UpdateRouteDriverAsync(Uri.UnescapeDataString(routeId), body);
                return Results.Json(new { ok = true, route });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 400);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // PUT /api/rk/routes/:routeId/ship — редактирование отгрузки (включая подтверждённые)
        app.MapPut("/api/rk/routes/{routeId}/ship", async (string routeId, ShipmentRequest body, RouteService svc) =>
        {
            try
            {
                var route = await svc.UpdateShipmentAsync(Uri.UnescapeDataString(routeId), body);
                return Results.Json(new { ok = true, route });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 400);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // PUT /api/rk/routes/:routeId/receive — редактирование приёмки
        app.MapPut("/api/rk/routes/{routeId}/receive", async (string routeId, ReceivingRequest body, RouteService svc) =>
        {
            try
            {
                var route = await svc.UpdateReceivingAsync(Uri.UnescapeDataString(routeId), body);
                return Results.Json(new { ok = true, route });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 400);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // POST /api/rk/routes/:routeId/confirm-ship — подтверждение отгрузки менеджером
        app.MapPost("/api/rk/routes/{routeId}/confirm-ship", async (string routeId, HttpContext ctx, RouteService svc, SessionService sessions) =>
        {
            try
            {
                var session = (VsSession)ctx.Items["vsSession"]!;
                var user = await sessions.FindUserByLoginAsync(session.Login);
                var confirmedBy = user?.Name ?? session.Login ?? null;
                var route = await svc.ConfirmShipmentAsync(Uri.UnescapeDataString(routeId), confirmedBy);
                return Results.Json(new { ok = true, route });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 400);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // POST /api/rk/routes/:routeId/confirm-receive — подтверждение приёмки менеджером
        app.MapPost("/api/rk/routes/{routeId}/confirm-receive", async (string routeId, HttpContext ctx, RouteService svc, SessionService sessions) =>
        {
            try
            {
                var session = (VsSession)ctx.Items["vsSession"]!;
                var user = await sessions.FindUserByLoginAsync(session.Login);
                var confirmedBy = user?.Name ?? session.Login ?? null;
                var route = await svc.ConfirmReceivingAsync(Uri.UnescapeDataString(routeId), confirmedBy);
                return Results.Json(new { ok = true, route });
            }
            catch (Exception err)
            {
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 400);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
