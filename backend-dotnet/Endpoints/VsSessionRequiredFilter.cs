using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Аналог middleware vsSessionRequired() из server.js — та же cookie `vs_sid`,
// та же таблица vs_sessions (через SessionService, читает базу zlp напрямую —
// Фаза 0 уже сделала сессии общими между Node и dotnet). При успехе кладёт
// VsSession в HttpContext.Items["vsSession"] — читается хендлерами, которым
// нужен login (confirm-ship/confirm-receive).
public class VsSessionRequiredFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var sessions = http.RequestServices.GetRequiredService<SessionService>();
        var sessionId = http.Request.Cookies["vs_sid"];
        var session = await sessions.GetSessionAsync(sessionId);
        if (session == null)
        {
            return Results.Json(new { error = "Требуется авторизация" }, statusCode: 401);
        }
        // Склад, выбранный на сайте (заголовок X-Warehouse): доступа к нему нет —
        // отказ; роль на этом складе своя (vs_user_warehouses) — подставляем её,
        // чтобы все проверки роли дальше (VsAdminRequiredFilter, хендлеры)
        // видели права именно на выбранном складе. Разработчик — везде разработчик.
        var asked = http.Request.Headers[WarehouseService.HeaderName].ToString().Trim();
        if (asked != "" && session.Role != "developer")
        {
            var warehouses = http.RequestServices.GetRequiredService<WarehouseService>();
            var row = (await warehouses.GetUserAccessAsync(session.Login)).FirstOrDefault(a => a.WarehouseId == asked);
            if (row == null) return Results.Json(new { error = "Нет доступа к этому складу" }, statusCode: 403);
            if (row.Role != null) session.Role = row.Role;
        }
        if (asked != "") http.Items["warehouseId"] = asked;
        http.Items["vsSession"] = session;
        return await next(context);
    }
}
