using System.Diagnostics;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Шлюз WMS (WmsGatewayService): запросы к WMS для сотрудников без своего доступа
// — через ПК-шлюз склада. Пользоваться шлюзом может только тот, кого одобрил
// разработчик (wms_gateway_access, status = approved); сотрудник сам оставляет
// заявку, разработчик одобряет или отзывает. Шлюзом работает любая вкладка
// сайта со своей живой сессией WMS (lib/wms/gatewayHost.js; в первой версии —
// только разработчик), управлять доступом — только разработчик. Каждый запрос
// через шлюз пишется в wms_gateway_log.
public static class WmsGatewayEndpoints
{
    public record AccessRow(string Login, string Name, string Status, DateTime? RequestedAt, DateTime? DecidedAt, string DecidedBy);
    public record LogRow(DateTime At, string Login, string WarehouseId, string Method, string Path, int Status, int Ms, string HostLogin);
    public record GatewayRequest(string? Method, string? Url, string? Body);
    public record GatewayResult(string? Id, string? Wh, int Status, string? Body);
    public record DecideRequest(string? Login, bool Approve);

    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(90);
    // задание целиком (выгрузка статистики за смену) — шлюз сам качает и сохраняет
    private static readonly TimeSpan TaskTimeout = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan PollWait = TimeSpan.FromSeconds(25);

    private static VsSession? Session(HttpContext ctx) => ctx.Items["vsSession"] as VsSession;
    private static bool IsDeveloper(HttpContext ctx) => Session(ctx)?.Role == "developer";
    private static string Wh(HttpContext ctx) => ctx.Items["warehouseId"] as string ?? "";
    private static IResult Error(string message, int status) =>
        Results.Json(new { error = message, gateway = true }, statusCode: status);

    private static async Task WriteLogAsync(AppDbContext db, string login, string wh, string method, string path, int status, Stopwatch sw, string? host)
    {
        try
        {
            await db.Database.ExecuteSqlInterpolatedAsync($@"
                INSERT INTO wms_gateway_log (login, warehouse_id, method, path, status, ms, host_login)
                VALUES ({login}, {wh}, {method}, {path}, {status}, {(int)sw.ElapsedMilliseconds}, {host ?? ""})");
        }
        catch { /* журнал не должен ронять ответ */ }
    }

    private static async Task<string> AccessStatusAsync(AppDbContext db, string login) =>
        (await db.Database.SqlQuery<string>($"SELECT status AS \"Value\" FROM wms_gateway_access WHERE login = {login}").ToListAsync()).FirstOrDefault() ?? "none";

    public static void MapWmsGatewayEndpoints(this WebApplication app)
    {
        // состояние для текущего пользователя и склада: есть ли доступ, в сети ли шлюз
        app.MapGet("/api/wms-gateway/status", async (HttpContext ctx, AppDbContext db, WmsGatewayService gw) =>
        {
            var login = Session(ctx)!.Login;
            var wh = Wh(ctx);
            var g = gw.Gateway(wh);
            return Results.Json(new
            {
                access = IsDeveloper(ctx) ? "approved" : await AccessStatusAsync(db, login),
                online = g.Online > 0,
                hosts = g.Online,
                lastSeen = g.LastSeen,
                isDeveloper = IsDeveloper(ctx),
            });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // Заявок от сотрудников нет: доступ выдаёт только разработчик, выбирая
        // человека из зарегистрированных на сайте (admin/decide). Оригинал:
        // «заявка на доступ к шлюзу — решает разработчик» (POST /access/request,
        // кнопка в боковом меню) — убрано 07.11.2026.

        // запрос к WMS через шлюз склада
        app.MapPost("/api/wms-gateway/request", async (GatewayRequest body, HttpContext ctx, AppDbContext db, WmsGatewayService gw, IServiceScopeFactory scopes) =>
        {
            var login = Session(ctx)!.Login;
            if (!IsDeveloper(ctx) && await AccessStatusAsync(db, login) != "approved")
                return Error("Нет доступа к шлюзу WMS — доступ выдаёт разработчик", 403);
            var wh = Wh(ctx);
            if (wh == "") return Error("Не выбран склад", 400);
            var method = (body.Method ?? "GET").ToUpperInvariant();
            var url = body.Url ?? "";
            var denied = WmsGatewayService.Validate(method, url);
            if (denied != null) return Error(denied, 403);
            if (!gw.IsOnline(wh)) return Error("Шлюз WMS этого склада не в сети", 503);

            var sw = Stopwatch.StartNew();
            var job = new WmsGatewayService.Job(Guid.NewGuid().ToString("N"), method, url, method == "GET" ? null : body.Body, login, wh);

            // задание целиком — в фоне, сотруднику сразу номер (см. TaskState)
            if (method == "TASK")
            {
                var task = gw.AddTask(job.Id, login);
                _ = Task.Run(async () =>
                {
                    var r = await gw.RunAsync(job, TaskTimeout, CancellationToken.None);
                    task.Code = r?.Status ?? 504;
                    task.Body = r?.Body ?? JsonSerializer.Serialize(new { error = "Шлюз WMS не выполнил задание вовремя" });
                    task.Status = "done";
                    using var scope = scopes.CreateScope();
                    await WriteLogAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>(), login, wh, method, url, task.Code, sw, job.HostLogin);
                });
                return Results.Json(new { taskId = job.Id });
            }

            var res = await gw.RunAsync(job, RequestTimeout, ctx.RequestAborted);
            await WriteLogAsync(db, login, wh, method, new Uri(url).AbsolutePath, res?.Status ?? 504, sw, job.HostLogin);
            if (res == null) return Error("Шлюз WMS не ответил вовремя", 504);
            ctx.Response.Headers["X-Wms-Gateway"] = "1";
            return Results.Content(res.Value.Body, "application/json; charset=utf-8", statusCode: res.Value.Status);
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // состояние задания: queued / running / done (+ код и ответ шлюза)
        app.MapGet("/api/wms-gateway/task/{id}", (string id, HttpContext ctx, WmsGatewayService gw) =>
        {
            var t = gw.GetTask(id);
            if (t == null || t.Login != Session(ctx)!.Login) return Error("Задание не найдено", 404);
            if (t.Status != "done") return Results.Json(new { status = t.Status });
            ctx.Response.Headers["X-Wms-Gateway"] = "1";
            return Results.Json(new { status = t.Status, code = t.Code, body = t.Body });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // ─── шлюз: вкладка сайта со своей сессией WMS ───────────────────────

        // долгий опрос: следующий запрос для склада, выбранного в WMS на шлюзе
        app.MapGet("/api/wms-gateway/next", async (string? wh, HttpContext ctx, WmsGatewayService gw) =>
        {
            if (string.IsNullOrWhiteSpace(wh)) return Error("Нужен склад WMS", 400);
            var job = await gw.NextAsync(wh, Session(ctx)!.Login, PollWait, ctx.RequestAborted);
            return job == null
                ? Results.Json(new { job = (object?)null, queue = 0 })
                : Results.Json(new { job = new { id = job.Id, method = job.Method, url = job.Url, body = job.Body, login = job.Login }, queue = gw.QueueLength(wh) });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/wms-gateway/result", (GatewayResult body, HttpContext ctx, WmsGatewayService gw) =>
        {
            var ok = gw.Complete(body.Id ?? "", body.Wh ?? "", Session(ctx)!.Login, body.Status, body.Body ?? "");
            return Results.Json(new { ok });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // ─── Управление доступом (только разработчик) ──────────────────────

        app.MapGet("/api/wms-gateway/admin", async (HttpContext ctx, AppDbContext db, WmsGatewayService gw, AuthService auth) =>
        {
            if (!IsDeveloper(ctx)) return Error("Только для разработчика", 403);
            var access = await db.Database.SqlQuery<AccessRow>($@"
                SELECT login AS ""Login"", COALESCE(name, '') AS ""Name"", status AS ""Status"", requested_at AS ""RequestedAt"",
                       decided_at AS ""DecidedAt"", COALESCE(decided_by, '') AS ""DecidedBy""
                FROM wms_gateway_access ORDER BY (status = 'pending') DESC, requested_at DESC").ToListAsync();
            var log = await db.Database.SqlQuery<LogRow>($@"
                SELECT at AS ""At"", login AS ""Login"", warehouse_id AS ""WarehouseId"", method AS ""Method"", path AS ""Path"", status AS ""Status"", ms AS ""Ms"", COALESCE(host_login, '') AS ""HostLogin""
                FROM wms_gateway_log ORDER BY id DESC LIMIT 300").ToListAsync();
            var wh = Wh(ctx);
            var g = gw.Gateway(wh);
            // зарегистрированные на сайте — для поиска «кому выдать» и имён в списках
            var users = (await auth.LoadVsUsersAsync())
                .Select(u => new { login = u.Login, name = u.Name ?? "", role = u.Role ?? "" })
                .OrderBy(u => u.name == "" ? u.login : u.name, StringComparer.Create(new System.Globalization.CultureInfo("ru-RU"), true))
                .ToList();
            return Results.Json(new
            {
                users,
                access,
                log,
                gateway = new
                {
                    online = g.Online > 0, hostsOnline = g.Online, lastSeen = g.LastSeen, done = g.Done, failed = g.Failed, queue = gw.QueueLength(wh),
                    hosts = g.Hosts.Select(h => new { login = h.Login, lastSeen = h.LastSeen, online = DateTime.UtcNow - h.LastSeen < WmsGatewayService.OnlineWindow, done = h.Done, failed = h.Failed }),
                },
            });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPost("/api/wms-gateway/admin/decide", async (DecideRequest body, HttpContext ctx, AppDbContext db, AuthService auth) =>
        {
            if (!IsDeveloper(ctx)) return Error("Только для разработчика", 403);
            var asked = (body.Login ?? "").Trim();
            if (asked == "") return Error("Нужен пользователь", 400);
            // выдать можно только зарегистрированному на сайте; отозвать — и запись без пользователя
            var user = await auth.FindUserByLoginAsync(asked);
            if (user == null && body.Approve) return Error("Такого пользователя на сайте нет", 404);
            var login = user?.Login ?? asked;
            var status = body.Approve ? "approved" : "revoked";
            var by = Session(ctx)!.Login;
            var name = user?.Name ?? "";
            await db.Database.ExecuteSqlInterpolatedAsync($@"
                INSERT INTO wms_gateway_access (login, name, status, requested_at, decided_at, decided_by) VALUES ({login}, {name}, {status}, now(), now(), {by})
                ON CONFLICT (login) DO UPDATE SET status = EXCLUDED.status, decided_at = now(), decided_by = EXCLUDED.decided_by,
                    name = COALESCE(NULLIF(EXCLUDED.name, ''), wms_gateway_access.name)");
            return Results.Json(new { ok = true });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // убрать запись из списка доступа (доступа у человека не будет)
        app.MapPost("/api/wms-gateway/admin/remove", async (DecideRequest body, HttpContext ctx, AppDbContext db) =>
        {
            if (!IsDeveloper(ctx)) return Error("Только для разработчика", 403);
            var login = (body.Login ?? "").Trim();
            await db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM wms_gateway_access WHERE login = {login}");
            return Results.Json(new { ok = true });
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
