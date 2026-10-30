using System.Text.Json;
using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Порт vs-auth.js/server.js (Фаза 4) — регистрация/логин/me/logout +
// админ-роуты ролей/заявок/пользователей. Дословный перенос 4-ветвистой
// логики /api/vs/auth/login (сайт-пароль [+опционально WMS-токен тем же
// паролем] / allowWithoutToken без пароля / WMS-пароль как единственная
// проверка).
//
// /api/vs/telegram/* и Telegram-consumer-loop остаются на Node — сюда не переносятся.
public static class AuthEndpoints
{
    private static readonly CookieOptions SessionCookieOptions = new()
    {
        HttpOnly = true,
        Path = "/",
        MaxAge = TimeSpan.FromDays(30),
        SameSite = SameSiteMode.Lax,
    };

    // Вход из сайта, встроенного в WMS расширением (iframe на wwh.samokat.ru):
    // Lax-cookie браузер во встроенное окно чужого сайта не отдаёт, поэтому
    // там нужна SameSite=None. Partitioned (CHIPS) — cookie живёт отдельно
    // «под» wwh.samokat.ru и не отправляется на robops.ru с других сайтов,
    // так что защита от подделки запросов (CSRF) не ослабевает. Обычный вход
    // на robops.ru по-прежнему с Lax.
    private static readonly CookieOptions EmbedSessionCookieOptions = CreateEmbedCookieOptions();

    private static CookieOptions CreateEmbedCookieOptions()
    {
        var o = new CookieOptions
        {
            HttpOnly = true,
            Path = "/",
            MaxAge = TimeSpan.FromDays(30),
            SameSite = SameSiteMode.None,
            Secure = true,
        };
        o.Extensions.Add("Partitioned");
        return o;
    }

    private static bool IsEmbedRequest(HttpContext ctx) => ctx.Request.Headers["X-Embed"] == "1";

    private static CookieOptions SessionCookieFor(HttpContext ctx) =>
        IsEmbedRequest(ctx) ? EmbedSessionCookieOptions : SessionCookieOptions;

    public static void MapAuthEndpoints(this WebApplication app)
    {
        app.MapPost("/api/vs/auth/register", async (JsonElement body, AuthService auth, WarehouseService warehouses) =>
        {
            try
            {
                var name = GetString(body, "name");
                var phone = GetString(body, "phone");
                var sitePassword = GetString(body, "sitePassword");
                if (string.IsNullOrEmpty(name?.Trim())) return Results.Json(new { ok = false, error = "Укажите ФИО" }, statusCode: 400);
                if (string.IsNullOrEmpty(phone?.Trim())) return Results.Json(new { ok = false, error = "Укажите номер телефона" }, statusCode: 400);
                if (string.IsNullOrEmpty(sitePassword?.Trim())) return Results.Json(new { ok = false, error = "Укажите пароль от сайта" }, statusCode: 400);
                var warehouseId = GetString(body, "warehouseId");
                if (!await warehouses.ExistsAsync(warehouseId)) return Results.Json(new { ok = false, error = "Выберите склад" }, statusCode: 400);
                var hash = AuthService.HashPassword(sitePassword!.Trim());
                await auth.AddPendingUserAsync(name!.Trim(), phone!, phone!, hash);
                await warehouses.SetPendingWarehouseAsync(AuthService.NormalizePhone(phone), warehouseId);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 400); }
        });

        // Справочник складов — для формы регистрации (только id и названия).
        app.MapGet("/api/vs/auth/warehouses", async (WarehouseService warehouses) =>
        {
            try { return Results.Json(await warehouses.GetAllAsync()); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapPost("/api/vs/auth/login", async (JsonElement body, HttpContext ctx, AuthService auth, WarehouseService warehouses) =>
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
                    ctx.Response.Cookies.Append(AuthConstants.SessionCookieName, sessionId, SessionCookieFor(ctx));
                    if (!user.AllowWithoutToken)
                    {
                        try
                        {
                            var samokatRes = await auth.SamokatLoginAsync(login!, password!);
                            if (!string.IsNullOrEmpty(samokatRes.AccessToken))
                            {
                                // справочник складов — свежий из WMS (фоном, вход не ждёт)
                                _ = Task.Run(() => warehouses.RefreshFromWmsAsync(samokatRes.AccessToken));
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
                    ctx.Response.Cookies.Append(AuthConstants.SessionCookieName, sessionId, SessionCookieFor(ctx));
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
                    _ = Task.Run(() => warehouses.RefreshFromWmsAsync(samokatRes.AccessToken));
                    var sessionId = await auth.CreateSessionAsync(user, login!);
                    var modules = user.Modules ?? await auth.GetModulesForRoleAsync(user.Role);
                    ctx.Response.Cookies.Append(AuthConstants.SessionCookieName, sessionId, SessionCookieFor(ctx));
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

        app.MapGet("/api/vs/auth/me", async (HttpContext ctx, AuthService auth, WarehouseService warehouses) =>
        {
            try
            {
                var sessionId = ctx.Request.Cookies[AuthConstants.SessionCookieName];
                var session = await auth.GetSessionAsync(sessionId);
                if (session == null) return Results.Json(new { error = "Сессия не найдена или истекла" }, statusCode: 401);
                var user = await auth.FindUserByLoginAsync(session.Login);
                var userRole = user?.Role ?? session.Role;
                var userModules = user?.Modules is { Count: > 0 } ? user.Modules : await auth.GetModulesForRoleAsync(userRole);
                var userActions = user != null ? (user.Actions ?? AuthConstants.GetActionsForRole(user.Role)) : new List<string>();
                // склады, доступные пользователю (разработчику — все), с названиями
                var allowed = (await warehouses.GetUserWarehouseIdsAsync(session.Login, userRole)).ToHashSet();
                var myWarehouses = (await warehouses.GetAllAsync()).Where(w => allowed.Contains(w.Id)).ToList();
                // роль, разделы и действия — на выбранном складе (у каждого склада свои)
                var current = await warehouses.ResolveRequestWarehouseOrDefaultAsync(ctx, session.Login, userRole);
                var row = (await warehouses.GetUserAccessAsync(session.Login)).FirstOrDefault(a => a.WarehouseId == current);
                var rights = await auth.RightsOnWarehouseAsync(userRole, userModules, userActions, row?.Role, row?.Modules, row?.Actions);
                return Results.Json(new
                {
                    warehouses = myWarehouses,
                    warehouseId = current,
                    defaultWarehouseId = WarehouseService.DefaultWarehouseId,
                    login = session.Login,
                    name = user?.Name,
                    role = rights.Role,
                    modules = rights.Modules,
                    actions = rights.Actions,
                    allowWithoutToken = session.AllowWithoutToken,
                    selfOnly = user?.SelfOnly ?? false,
                    companyIds = rights.Role == "manager" && session.CompanyIds is { Count: > 0 } ? session.CompanyIds : null,
                });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // Сигнал «я на сайте» — раз в минуту, пока вкладка открыта и видна (см.
        // AuthService.TouchPresenceAsync). Заодно продлевает сессию.
        app.MapPost("/api/vs/auth/ping", async (HttpContext ctx, AuthService auth) =>
        {
            try
            {
                var session = await auth.GetSessionAsync(ctx.Request.Cookies[AuthConstants.SessionCookieName]);
                if (session == null) return Results.Json(new { error = "Сессия не найдена или истекла" }, statusCode: 401);
                await auth.TouchPresenceAsync(session.Login);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapPost("/api/vs/auth/logout", async (HttpContext ctx, AuthService auth) =>
        {
            try
            {
                var sessionId = ctx.Request.Cookies[AuthConstants.SessionCookieName];
                if (!string.IsNullOrEmpty(sessionId)) await auth.DestroySessionAsync(sessionId);
                ctx.Response.Cookies.Delete(AuthConstants.SessionCookieName, IsEmbedRequest(ctx) ? CreateEmbedCookieOptions() : new CookieOptions { Path = "/" });
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

        app.MapGet("/api/vs/admin/pending", async (HttpContext ctx, AuthService auth, WarehouseService warehouses) =>
        {
            try
            {
                // администратор склада видит заявки только на свои склады
                var mine = await ManageableWarehousesAsync(ctx, auth, warehouses);
                var byPhone = await warehouses.GetPendingWarehousesAsync();
                var list = (await auth.GetPendingUsersAsync())
                    .Select(p => new { p, wh = byPhone.GetValueOrDefault(AuthService.NormalizePhone(p.Phone), WarehouseService.DefaultWarehouseId) })
                    .Where(x => mine.Contains(x.wh))
                    .Select(x => new { x.p.Name, x.p.Phone, x.p.WmsPhone, x.p.RegisteredAt, x.p.Status, warehouseId = x.wh });
                return Results.Json(list);
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapPost("/api/vs/admin/pending/approve", async (HttpContext ctx, JsonElement body, AuthService auth, WarehouseService warehouses) =>
        {
            try
            {
                var phone = GetString(body, "phone");
                if (string.IsNullOrEmpty(phone)) return Results.Json(new { error = "Укажите номер телефона" }, statusCode: 400);
                var mine = await ManageableWarehousesAsync(ctx, auth, warehouses);
                var wh = (await warehouses.GetPendingWarehousesAsync()).GetValueOrDefault(AuthService.NormalizePhone(phone), WarehouseService.DefaultWarehouseId);
                if (!mine.Contains(wh)) return Results.Json(new { error = "Заявка на чужой склад" }, statusCode: 403);
                var role = GetString(body, "role");
                var modules = GetStringList(body, "modules");
                await auth.ApprovePendingUserAsync(phone!, role, modules);
                await warehouses.SetUserWarehousesAsync(phone!, new[] { wh }, mine, await auth.ResolveRoleAsync(role));
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 400); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapDelete("/api/vs/admin/pending/{phone}", async (HttpContext ctx, string phone, AuthService auth, WarehouseService warehouses) =>
        {
            try
            {
                var mine = await ManageableWarehousesAsync(ctx, auth, warehouses);
                var wh = (await warehouses.GetPendingWarehousesAsync()).GetValueOrDefault(AuthService.NormalizePhone(phone), WarehouseService.DefaultWarehouseId);
                if (!mine.Contains(wh)) return Results.Json(new { error = "Заявка на чужой склад" }, statusCode: 403);
                await auth.RejectPendingUserAsync(phone);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        // ─── Пользователи (admin) ────────────────────────────────────────────

        app.MapGet("/api/vs/admin/users", async (HttpContext ctx, AuthService auth, WarehouseService warehouses) =>
        {
            try
            {
                // администратор склада видит только пользователей своих складов
                // (и в их списке — только свои склады); разработчик — всех
                var mine = await ManageableWarehousesAsync(ctx, auth, warehouses);
                var isDev = await IsDeveloperAsync(ctx, auth);
                var allAccess = await warehouses.GetAllAccessAsync();
                var current = ctx.Request.Headers[WarehouseService.HeaderName].ToString().Trim();
                var result = new List<Dictionary<string, object?>>();
                foreach (var u in await auth.GetAllUsersForAdminAsync())
                {
                    var login = (string?)u["login"] ?? "";
                    if (u["hasAccess"] is true)
                    {
                        var rows = allAccess.GetValueOrDefault(WarehouseService.Key(login)) ?? new List<WarehouseService.Access>();
                        var visible = rows.Where(a => mine.Contains(a.WarehouseId)).ToList();
                        if (!isDev && visible.Count == 0 && rows.Count > 0) continue;
                        // права на каждом видимом складе: { склад: { role, modules, actions } }
                        var rights = new Dictionary<string, AuthService.Rights>();
                        foreach (var a in visible)
                            rights[a.WarehouseId] = await auth.RightsOnWarehouseAsync((string?)u["role"], u["modules"] as List<string>, u["actions"] as List<string>, a.Role, a.Modules, a.Actions);
                        u["access"] = rights.ToDictionary(kv => kv.Key, kv => (object)new { role = kv.Value.Role, modules = kv.Value.Modules, actions = kv.Value.Actions });
                        u["warehouseIds"] = visible.Select(a => a.WarehouseId).ToList();
                        u["otherWarehouses"] = rows.Count - visible.Count; // склады, которых этот админ не видит
                        // role/modules/actions в корне — на выбранном сейчас складе (или первом видимом)
                        var main = visible.FirstOrDefault(a => a.WarehouseId == current) ?? visible.FirstOrDefault();
                        if (main != null)
                        {
                            var rt = rights[main.WarehouseId];
                            u["role"] = rt.Role; u["modules"] = rt.Modules; u["actions"] = rt.Actions;
                        }
                    }
                    else if (!isDev) continue; // попытки входа без доступа — склад неизвестен
                    result.Add(u);
                }
                return Results.Json(result);
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapPut("/api/vs/admin/users", async (HttpContext ctx, JsonElement body, AuthService auth, WarehouseService warehouses) =>
        {
            try
            {
                var login = GetString(body, "login");
                if (string.IsNullOrEmpty(login?.Trim())) return Results.Json(new { error = "Укажите логин (номер телефона или буквенный)" }, statusCode: 400);
                if (await DeniedDeveloperChange(ctx, auth, login)) return Results.Json(new { error = "Разработчика может менять только разработчик" }, statusCode: 403);
                var mine = await ManageableWarehousesAsync(ctx, auth, warehouses);
                var existing = await auth.FindUserByLoginAsync(login);
                if (existing != null && !await CanManageUserAsync(ctx, warehouses, existing.Login, mine))
                    return Results.Json(new { error = "Пользователь с другого склада" }, statusCode: 403);
                var payload = new AuthService.SaveUserPayload();
                // права на складах: access — все склады пользователя (из тех, что у
                // админа) с ролью/разделами/действиями на каждом (карточка);
                // warehouseId — роль/разделы/действия только на этом складе (массовые)
                var accessList = ParseAccess(body);
                var oneWarehouse = GetString(body, "warehouseId");
                if (body.TryGetProperty("name", out var nameEl)) { payload.NameSet = true; payload.Name = nameEl.ValueKind == JsonValueKind.String ? nameEl.GetString() : null; }
                // роль/разделы/действия в корне — у пользователя в целом (только
                // если не указан склад) — «как у пользователя» для складов без своих прав
                var perWarehouse = oneWarehouse != null;
                if (body.TryGetProperty("role", out var roleEl)) { payload.RoleSet = !perWarehouse; payload.Role = roleEl.ValueKind == JsonValueKind.String ? roleEl.GetString() : null; }
                if (body.TryGetProperty("modules", out var modulesEl)) { payload.ModulesSet = !perWarehouse; payload.Modules = GetStringList(modulesEl); }
                if (body.TryGetProperty("actions", out var actionsEl)) { payload.ActionsSet = !perWarehouse; payload.Actions = GetStringList(actionsEl); }
                // новому пользователю без роли в корне — роль первого склада
                if (existing == null && !payload.RoleSet && accessList?.FirstOrDefault()?.Role is string firstRole) { payload.RoleSet = true; payload.Role = firstRole; }
                if (body.TryGetProperty("shiftType", out var shiftEl)) { payload.ShiftTypeSet = true; payload.ShiftType = shiftEl.ValueKind == JsonValueKind.String ? shiftEl.GetString() : null; }
                if (body.TryGetProperty("companyIds", out var companyIdsEl)) { payload.CompanyIdsSet = true; payload.CompanyIds = GetStringList(companyIdsEl); }
                if (body.TryGetProperty("visibleCompanies", out var visCompEl)) { payload.VisibleCompaniesSet = true; payload.VisibleCompanies = GetStringList(visCompEl); }
                if (body.TryGetProperty("allowWithoutToken", out var awtEl)) { payload.AllowWithoutTokenSet = true; payload.AllowWithoutToken = awtEl.ValueKind == JsonValueKind.True; }
                if (body.TryGetProperty("selfOnly", out var selfOnlyEl)) { payload.SelfOnlySet = true; payload.SelfOnly = selfOnlyEl.ValueKind == JsonValueKind.True; }
                if (body.TryGetProperty("password", out var pwdEl)) { payload.PasswordSet = true; payload.Password = pwdEl.ValueKind == JsonValueKind.String ? pwdEl.GetString() : null; }
                await auth.SaveUserAsync(login!, payload);
                // склады: явно переданные; новому пользователю без списка —
                // склад, выбранный сейчас у администратора
                if (accessList != null)
                {
                    var checkedList = new List<WarehouseService.Access>();
                    foreach (var a in accessList)
                        checkedList.Add(a with
                        {
                            Role = a.Role != null ? await auth.ResolveRoleAsync(a.Role) : null,
                            Modules = a.Modules?.Where(m => AuthConstants.AllModules.Contains(m)).ToList(),
                            Actions = a.Actions?.Where(x => AuthConstants.AllActions.Contains(x)).ToList(),
                        });
                    await warehouses.SetUserAccessAsync(login!, checkedList, mine);
                }
                else if (perWarehouse)
                {
                    if (!mine.Contains(oneWarehouse!)) return Results.Json(new { error = "Склад вам недоступен" }, statusCode: 403);
                    var role = payload.Role != null ? await auth.ResolveRoleAsync(payload.Role) : null;
                    var changed = await warehouses.UpdateAccessAsync(login!, oneWarehouse!,
                        body.TryGetProperty("role", out _), role,
                        body.TryGetProperty("modules", out _), payload.Modules?.Where(m => AuthConstants.AllModules.Contains(m)).ToList(),
                        body.TryGetProperty("actions", out _), payload.Actions?.Where(x => AuthConstants.AllActions.Contains(x)).ToList());
                    if (!changed) return Results.Json(new { error = "У пользователя нет этого склада" }, statusCode: 400);
                }
                else
                {
                    var whIds = GetStringList(body, "warehouseIds");
                    if (whIds == null && existing == null)
                    {
                        var me = ctx.Items["vsSession"] as VsSession;
                        var cur = await warehouses.ResolveRequestWarehouseAsync(ctx, me?.Login, me?.Role);
                        if (cur != null) whIds = new List<string> { cur };
                    }
                    if (whIds != null) await warehouses.SetUserWarehousesAsync(login!, whIds, mine);
                }
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        app.MapDelete("/api/vs/admin/users/{login}", async (HttpContext ctx, string login, AuthService auth, WarehouseService warehouses) =>
        {
            try
            {
                if (string.IsNullOrEmpty(login.Trim())) return Results.Json(new { error = "Укажите логин" }, statusCode: 400);
                if (await DeniedDeveloperChange(ctx, auth, login)) return Results.Json(new { error = "Разработчика может удалить только разработчик" }, statusCode: 403);
                var mine = await ManageableWarehousesAsync(ctx, auth, warehouses);
                if (!await CanManageUserAsync(ctx, warehouses, login, mine))
                    return Results.Json(new { error = "Пользователь с другого склада" }, statusCode: 403);
                // у пользователя есть склады, которыми этот админ не управляет, —
                // убираем только его склады, сама учётка остаётся
                var others = (await warehouses.GetUserWarehouseIdsAsync(login, null)).Where(w => !mine.Contains(w)).ToList();
                if (others.Count > 0)
                {
                    await warehouses.SetUserWarehousesAsync(login, Array.Empty<string>(), mine);
                    return Results.Json(new { ok = true, removedFromWarehousesOnly = true });
                }
                await auth.RemoveUserAsync(login);
                await warehouses.RemoveUserAsync(login);
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();
    }

    /// <summary>Склады, которыми управляет текущий администратор: где его роль
    /// на складе — «Администратор» (роль своя на каждом складе). Разработчик — всеми.</summary>
    private static async Task<HashSet<string>> ManageableWarehousesAsync(HttpContext ctx, AuthService auth, WarehouseService warehouses)
    {
        var s = ctx.Items["vsSession"] as VsSession;
        var me = await auth.FindUserByLoginAsync(s?.Login);
        if (me == null) return new();
        if (me.Role == "developer") return (await warehouses.GetAllAsync()).Select(w => w.Id).ToHashSet();
        return (await warehouses.GetUserAccessAsync(me.Login))
            .Where(a => (a.Role ?? me.Role) == "admin")
            .Select(a => a.WarehouseId)
            .ToHashSet();
    }

    private static async Task<bool> IsDeveloperAsync(HttpContext ctx, AuthService auth) =>
        (await auth.FindUserByLoginAsync((ctx.Items["vsSession"] as VsSession)?.Login))?.Role == "developer";

    /// <summary>access: [{ warehouseId, role, modules, actions }] из тела запроса (null — не передан).</summary>
    private static List<WarehouseService.Access>? ParseAccess(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("access", out var arr) || arr.ValueKind != JsonValueKind.Array) return null;
        var list = new List<WarehouseService.Access>();
        foreach (var el in arr.EnumerateArray())
        {
            var id = GetString(el, "warehouseId");
            if (string.IsNullOrWhiteSpace(id)) continue;
            list.Add(new WarehouseService.Access(id, GetString(el, "role"), GetStringList(el, "modules"), GetStringList(el, "actions")));
        }
        return list;
    }

    /// <summary>Администратор склада меняет пользователя, только если у того
    /// есть хотя бы один из его складов (или складов нет вовсе).</summary>
    private static async Task<bool> CanManageUserAsync(HttpContext ctx, WarehouseService warehouses, string targetLogin, HashSet<string> mine)
    {
        if ((ctx.Items["vsSession"] as VsSession)?.Role == "developer") return true;
        var theirs = await warehouses.GetUserWarehouseIdsAsync(targetLogin, null);
        return theirs.Count == 0 || theirs.Any(mine.Contains);
    }

    // Пользователя из VS_DEVELOPER_LOGINS (см. AuthService.IsDeveloperLogin)
    // правит и удаляет только другой разработчик, не администратор.
    private static async Task<bool> DeniedDeveloperChange(HttpContext ctx, AuthService auth, string? targetLogin)
    {
        if (!AuthService.IsDeveloperLogin(targetLogin)) return false;
        var session = await auth.GetSessionAsync(ctx.Request.Cookies[AuthConstants.SessionCookieName]);
        return session?.Role != "developer";
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
