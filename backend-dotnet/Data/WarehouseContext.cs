using BackendDotnet.Services;

namespace BackendDotnet.Data;

// Склад запроса: заголовок X-Warehouse (ставит сайт, frontend-app/src/lib/api.js;
// Node пересылает его при своих вызовах dotnet). Без заголовка — СПБ-3, как
// было до разделения по складам.
//
// Заголовок проверяется для всех запросов, а не только там, где стоит
// VsSessionRequiredFilter: часть эндпоинтов статистики открыта без сессии, и
// без этой проверки любой мог бы прочитать данные чужого склада, просто
// подставив заголовок. Склад принимается, если:
//  - есть сессия и у пользователя есть доступ к складу (разработчику — любой);
//  - или это внутренний вызов от Node по сети docker: такие запросы приходят
//    мимо Caddy, без X-Forwarded-For (Caddy ставит его всегда, подделать
//    отсутствие из браузера нельзя). Node сам проверил пользователя.
public static class WarehouseContext
{
    public const string ItemKey = "warehouseId";

    public static string Current(HttpContext? ctx) =>
        ctx?.Items[ItemKey] as string ?? WarehouseService.DefaultWarehouseId;

    public static void UseWarehouseContext(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            var asked = ctx.Request.Headers[WarehouseService.HeaderName].ToString().Trim();
            if (asked == "")
            {
                ctx.Items[ItemKey] = WarehouseService.DefaultWarehouseId;
                await next();
                return;
            }

            var internalCall = string.IsNullOrEmpty(ctx.Request.Headers["X-Forwarded-For"].ToString());
            if (!internalCall)
            {
                var sessions = ctx.RequestServices.GetRequiredService<SessionService>();
                var session = await sessions.GetSessionAsync(ctx.Request.Cookies["vs_sid"]);
                if (session == null)
                {
                    await Results.Json(new { error = "Требуется авторизация" }, statusCode: 401).ExecuteAsync(ctx);
                    return;
                }
                var developer = session.Role == "developer" || AuthService.IsDeveloperLogin(session.Login);
                if (!developer)
                {
                    var warehouses = ctx.RequestServices.GetRequiredService<WarehouseService>();
                    var access = await warehouses.GetUserAccessAsync(session.Login);
                    if (!access.Any(a => a.WarehouseId == asked))
                    {
                        await Results.Json(new { error = "Нет доступа к этому складу" }, statusCode: 403).ExecuteAsync(ctx);
                        return;
                    }
                }
            }
            ctx.Items[ItemKey] = asked;
            await next();
        });
    }
}
