using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Аналог middleware vsAdminRequired() из server.js — требует, чтобы
// VsSessionRequiredFilter уже отработал и положил VsSession в HttpContext.Items.
// Всегда используется ПОСЛЕ VsSessionRequiredFilter в цепочке (тот же порядок,
// что и в оригинале: vsSessionRequired, vsAdminRequired).
public class VsAdminRequiredFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var session = context.HttpContext.Items["vsSession"] as VsSession;
        if (session?.Role != "admin" && session?.Role != "developer")
        {
            return Results.Json(new { error = "Требуются права администратора" }, statusCode: 403);
        }
        return await next(context);
    }
}
