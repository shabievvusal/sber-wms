using System.Text.Json;
using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Порт vs-auth.js/server.js (Фаза 4) — регистрация/логин/me/logout +
// админ-роуты ролей/заявок/пользователей. Дословный перенос 4-ветвистой
// логики /api/vs/auth/login (сайт-пароль [+опционально WMS-токен тем же
// паролем] / allowWithoutToken без пароля / WMS-пароль как единственная
// проверка) — см. PLAN.md.
//
// /api/vs/telegram/* и Telegram-consumer-loop остаются на Node (см. PLAN.md,
// «что остаётся на Node») — сюда не переносятся.
public static class AuthEndpoints
{
    private static readonly CookieOptions SessionCookieOptions = new()
    {
        HttpOnly = true,
        Path = "/",
        MaxAge = TimeSpan.FromDays(30),
        SameSite = SameSiteMode.Lax,
    };

    public static void MapAuthEndpoints(this WebApplication app)
    {
        app.MapPost("/api/vs/auth/register", async (JsonElement body, AuthService auth) =>
        {
            try
            {
                var name = GetString(body, "name");
                var phone = GetString(body, "phone");
                var sitePassword = GetString(body, "sitePassword");
                if (string.IsNullOrEmpty(name?.Trim())) return Results.Json(new { ok = false, error = "Укажите ФИО" }, statusCode: 400);
                if (string.IsNullOrEmpty(phone?.Trim())) return Results.Json(new { ok = false, error = "Укажите номер телефона" }, statusCode: 400);
                if (string.IsNullOrEmpty(sitePassword?.Trim())) return Results.Json(new { ok = false, error = "Укажите пароль от сайта" }, statusCode: 400);
                var hash = AuthService.HashPassword(sitePassword!.Trim());
                await auth.AddPendingUserAsync(name!.Trim(), phone!, phone!, hash);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        });

        app.MapPost("/api/vs/auth/login", async (JsonElement body, HttpContext ctx, AuthService auth) =>
        {
            var login = GetString(body, "login");
            try
            {
                var password = GetString(body, "password");
                if (string.IsNullOrEmpty(login) || string.IsNullOrEmpty(password))
                    return Results.Json(new { ok = false, error = "Укажите логин и пароль" }, statusCode: 400);

                var user = await auth.FindUserByLoginAsync(login);
                if (user == null)
                {
                    await auth.RecordLoginAttemptAsync(login, false);
                    var pending = await auth.GetPendingUsersAsync();
                    var isPending = pending.Any(p => AuthService.NormalizePhone(p.Phone) == AuthService.NormalizePhone(login));
                    if (isPending) return Results.Json(new { ok = false, error = "Ваша заявка на доступ ещё не одобрена администратором" }, statusCode: 403);
                    return Results.Json(new { ok = false, error = "Вы не зарегистрованы на сайте" }, statusCode: 403);
                }

                var userActions = user.Actions ?? AuthConstants.GetActionsForRole(user.Role);
                object? companyIds = user.Role == "manager" && user.CompanyIds is { Count: > 0 } ? user.CompanyIds : null;

                if (!string.IsNullOrEmpty(user.PasswordHash) && AuthService.VerifyPassword(password!, user.PasswordHash))
                {
                    await auth.RecordLoginAttemptAsync(login, true);
                    var sessionId = await auth.CreateSessionAsync(user, login!);
                    var modules = user.Modules ?? await auth.GetModulesForRoleAsync(user.Role);
                    ctx.Response.Cookies.Append(AuthConstants.SessionCookieName, sessionId, SessionCookieOptions);
                    if (!user.AllowWithoutToken)
                    {
                        try
                        {
                            var samokatRes = await auth.SamokatLoginAsync(login!, password!);
                            if (!string.IsNullOrEmpty(samokatRes.AccessToken))
                            {
                                return Results.Json(new
                                {
                                    ok = true, role = user.Role, modules, actions = userActions,
                                    accessToken = samokatRes.AccessToken, expiresIn = samokatRes.ExpiresIn,
                                    refreshToken = samokatRes.RefreshToken ?? "",
                                    name = user.Name, companyIds,
                                });
                            }
                        }
                        catch { /* WMS пароль не совпал — входим без токена */ }
                    }
                    return Results.Json(new
                    {
                        ok = true, role = user.Role, modules, actions = userActions,
                        allowWithoutToken = user.AllowWithoutToken,
                        name = user.Name, companyIds,
                    });
                }

                if (user.AllowWithoutToken && !string.IsNullOrEmpty(user.PasswordHash))
                {
                    await auth.RecordLoginAttemptAsync(login, false);
                    return Results.Json(new { ok = false, error = "Неверный пароль" }, statusCode: 401);
                }

                if (user.AllowWithoutToken && string.IsNullOrEmpty(user.PasswordHash))
                {
                    await auth.RecordLoginAttemptAsync(login, true);
                    var sessionId = await auth.CreateSessionAsync(user, login!);
                    var modules = user.Modules ?? await auth.GetModulesForRoleAsync(user.Role);
                    ctx.Response.Cookies.Append(AuthConstants.SessionCookieName, sessionId, SessionCookieOptions);
                    return Results.Json(new
                    {
                        ok = true, role = user.Role, modules, actions = userActions, allowWithoutToken = true,
                        name = user.Name, companyIds,
                    });
                }

                try
                {
                    var samokatRes = await auth.SamokatLoginAsync(login!, password!);
                    if (string.IsNullOrEmpty(samokatRes.AccessToken))
                    {
                        await auth.RecordLoginAttemptAsync(login, false);
                        return Results.Json(new { ok = false, error = "Неверный пароль" }, statusCode: 401);
                    }
                    await auth.RecordLoginAttemptAsync(login, true);
                    var sessionId = await auth.CreateSessionAsync(user, login!);
                    var modules = user.Modules ?? await auth.GetModulesForRoleAsync(user.Role);
                    ctx.Response.Cookies.Append(AuthConstants.SessionCookieName, sessionId, SessionCookieOptions);
                    return Results.Json(new
                    {
                        ok = true, role = user.Role, modules, actions = userActions,
                        accessToken = samokatRes.AccessToken, expiresIn = samokatRes.ExpiresIn,
                        name = user.Name, refreshToken = samokatRes.RefreshToken ?? "", companyIds,
                    });
                }
                catch
                {
                    await auth.RecordLoginAttemptAsync(login, false);
                    return Results.Json(new { ok = false, error = "Неверный пароль" }, statusCode: 401);
                }
            }
            catch (Exception err)
            {
                if (!string.IsNullOrEmpty(login)) await auth.RecordLoginAttemptAsync(login, false);
                Console.Error.WriteLine($"POST /api/vs/auth/login: {err}");
                return Results.Json(new { ok = false, error = err.Message }, statusCode: 500);
            }
        });

        app.MapGet("/api/vs/auth/me", async (HttpContext ctx, AuthService auth) =>
        {
            try
            {
                var sessionId = ctx.Request.Cookies[AuthConstants.SessionCookieName];
                var session = await auth.GetSessionAsync(sessionId);
                if (session == null) return Results.Json(new { error = "Сессия не найдена или истекла" }, statusCode: 401);
                var user = await auth.FindUserByLoginAsync(session.Login);
                var modules = user?.Modules is { Count: > 0 } ? user.Modules : await auth.GetModulesForRoleAsync(session.Role);
                var actions = user != null ? (user.Actions ?? AuthConstants.GetActionsForRole(user.Role)) : new List<string>();
                return Results.Json(new
                {
                    name = user?.Name,
                    role = session.Role,
                    modules,
                    actions,
                    allowWithoutToken = session.AllowWithoutToken,
                    selfOnly = user?.SelfOnly ?? false,
                    companyIds = session.Role == "manager" && session.CompanyIds is { Count: > 0 } ? session.CompanyIds : null,
                });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapPost("/api/vs/auth/logout", async (HttpContext ctx, AuthService auth) =>
        {
            try
            {
                var sessionId = ctx.Request.Cookies[AuthConstants.SessionCookieName];
                if (!string.IsNullOrEmpty(sessionId)) await auth.DestroySessionAsync(sessionId);
                ctx.Response.Cookies.Delete(AuthConstants.SessionCookieName, new CookieOptions { Path = "/" });
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // ─── Custom roles (admin) ────────────────────────────────────────────

        app.MapGet("/api/vs/admin/roles", async (AuthService auth) =>
        {
            try { return Results.Json(await auth.GetAllRolesAsync()); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapPost("/api/vs/admin/roles", async (JsonElement body, AuthService auth) =>
        {
            try
            {
                var label = GetString(body, "label");
                if (string.IsNullOrEmpty(label?.Trim())) return Results.Json(new { error = "Укажите название роли" }, statusCode: 400);
                var key = GetString(body, "key");
                var modules = GetStringList(body, "modules");
                var finalKey = await auth.AddCustomRoleAsync(key, label, modules);
                return Results.Json(new { ok = true, key = finalKey });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapPut("/api/vs/admin/roles/{key}", async (string key, JsonElement body, AuthService auth) =>
        {
            try
            {
                var label = GetString(body, "label");
                var modules = GetStringList(body, "modules");
                await auth.UpdateCustomRoleAsync(key, label, modules);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapDelete("/api/vs/admin/roles/{key}", async (string key, AuthService auth) =>
        {
            try { await auth.DeleteCustomRoleAsync(key); return Results.Json(new { ok = true }); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        // ─── Pending registration requests (admin) ───────────────────────────

        app.MapGet("/api/vs/admin/pending", async (AuthService auth) =>
        {
            try { return Results.Json(await auth.GetPendingUsersAsync()); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapPost("/api/vs/admin/pending/approve", async (JsonElement body, AuthService auth) =>
        {
            try
            {
                var phone = GetString(body, "phone");
                if (string.IsNullOrEmpty(phone)) return Results.Json(new { error = "Укажите номер телефона" }, statusCode: 400);
                var role = GetString(body, "role");
                var modules = GetStringList(body, "modules");
                await auth.ApprovePendingUserAsync(phone!, role, modules);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapDelete("/api/vs/admin/pending/{phone}", async (string phone, AuthService auth) =>
        {
            try { await auth.RejectPendingUserAsync(phone); return Results.Json(new { ok = true }); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        // ─── Пользователи (admin) ────────────────────────────────────────────

        app.MapGet("/api/vs/admin/users", async (AuthService auth) =>
        {
            try { return Results.Json(await auth.GetAllUsersForAdminAsync()); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapPut("/api/vs/admin/users", async (JsonElement body, AuthService auth) =>
        {
            try
            {
                var login = GetString(body, "login");
                if (string.IsNullOrEmpty(login?.Trim())) return Results.Json(new { error = "Укажите логин (номер телефона или буквенный)" }, statusCode: 400);
                var payload = new AuthService.SaveUserPayload();
                if (body.TryGetProperty("name", out var nameEl)) { payload.NameSet = true; payload.Name = nameEl.ValueKind == JsonValueKind.String ? nameEl.GetString() : null; }
                if (body.TryGetProperty("role", out var roleEl)) { payload.RoleSet = true; payload.Role = roleEl.ValueKind == JsonValueKind.String ? roleEl.GetString() : null; }
                if (body.TryGetProperty("modules", out var modulesEl)) { payload.ModulesSet = true; payload.Modules = GetStringList(modulesEl); }
                if (body.TryGetProperty("actions", out var actionsEl)) { payload.ActionsSet = true; payload.Actions = GetStringList(actionsEl); }
                if (body.TryGetProperty("shiftType", out var shiftEl)) { payload.ShiftTypeSet = true; payload.ShiftType = shiftEl.ValueKind == JsonValueKind.String ? shiftEl.GetString() : null; }
                if (body.TryGetProperty("companyIds", out var companyIdsEl)) { payload.CompanyIdsSet = true; payload.CompanyIds = GetStringList(companyIdsEl); }
                if (body.TryGetProperty("visibleCompanies", out var visCompEl)) { payload.VisibleCompaniesSet = true; payload.VisibleCompanies = GetStringList(visCompEl); }
                if (body.TryGetProperty("allowWithoutToken", out var awtEl)) { payload.AllowWithoutTokenSet = true; payload.AllowWithoutToken = awtEl.ValueKind == JsonValueKind.True; }
                if (body.TryGetProperty("selfOnly", out var selfOnlyEl)) { payload.SelfOnlySet = true; payload.SelfOnly = selfOnlyEl.ValueKind == JsonValueKind.True; }
                if (body.TryGetProperty("password", out var pwdEl)) { payload.PasswordSet = true; payload.Password = pwdEl.ValueKind == JsonValueKind.String ? pwdEl.GetString() : null; }
                await auth.SaveUserAsync(login!, payload);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapDelete("/api/vs/admin/users/{login}", async (string login, AuthService auth) =>
        {
            try
            {
                if (string.IsNullOrEmpty(login.Trim())) return Results.Json(new { error = "Укажите логин" }, statusCode: 400);
                await auth.RemoveUserAsync(login);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();
    }

    private static string? GetString(JsonElement body, string prop) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;

    private static List<string>? GetStringList(JsonElement body, string prop) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(prop, out var el) ? GetStringList(el) : null;

    private static List<string>? GetStringList(JsonElement el)
    {
        if (el.ValueKind != JsonValueKind.Array) return null;
        var list = new List<string>();
        foreach (var item in el.EnumerateArray())
            if (item.ValueKind == JsonValueKind.String) list.Add(item.GetString()!);
        return list;
    }
}
