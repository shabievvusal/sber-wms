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
        http.Items["vsSession"] = session;
        return await next(context);
    }
}
