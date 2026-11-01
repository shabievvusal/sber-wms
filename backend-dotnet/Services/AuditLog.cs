using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing.Patterns;
using Npgsql;
using BackendDotnet.Endpoints;
using BackendDotnet.Data;

namespace BackendDotnet.Services;

// Журнал действий на сайте (Настройки → Журнал). Одна прослойка после всех
// эндпоинтов: каждый запрос, который что-то меняет (POST/PUT/PATCH/DELETE),
// пишется в audit_log — кто (сессия), когда, с какого адреса, что за действие,
// чем закончилось (код ответа) и с какими данными. Пароли/токены вырезаются,
// длинные списки сокращаются до «N шт.». Служебные фоновые запросы (выгрузка
// из WMS, обновление ЕО, присутствие, автосверка) не пишутся — их тысячи в день.
// Хранится год (AuditCleanupService).
public static class AuditLog
{
    // «МЕТОД шаблон маршрута» → действие по-русски. Маршрут, которого здесь нет
    // и нет в Skip, всё равно пишется — с адресом вместо названия.
    private static readonly Dictionary<string, string> Labels = new()
    {
        ["POST /api/vs/auth/login"] = "Вход на сайт",
        ["POST /api/vs/auth/logout"] = "Выход с сайта",
        ["POST /api/vs/auth/register"] = "Заявка на регистрацию",
        ["PUT /api/vs/admin/users"] = "Изменил пользователя",
        ["DELETE /api/vs/admin/users/{login}"] = "Удалил пользователя",
        ["POST /api/vs/admin/roles"] = "Создал роль",
        ["PUT /api/vs/admin/roles/{key}"] = "Изменил роль",
        ["DELETE /api/vs/admin/roles/{key}"] = "Удалил роль",
        ["POST /api/vs/admin/pending/approve"] = "Одобрил заявку на доступ",
        ["DELETE /api/vs/admin/pending/{phone}"] = "Отклонил заявку на доступ",
        ["PUT /api/vs/admin/auto-fetch-settings"] = "Изменил настройки автообновления",
        ["POST /api/vs/request-fetch"] = "Запросил обновление данных",
        ["PUT /api/rollcall"] = "Изменил перекличку",

        ["POST /api/empl"] = "Изменил сотрудника",
        ["POST /api/employees"] = "Сохранил список сотрудников",
        ["POST /api/empl/add-new"] = "Добавил новых сотрудников",
        ["POST /api/empl/account-check"] = "Проверил учётки ТСД",
        ["POST /api/stats/shift-data/delete"] = "Удалил данные за смену",
        ["POST /api/cell-stores/sync"] = "Обновил справочник ячеек → ЦФЗ",
        ["POST /api/cell-stores/delete-zone"] = "Удалил зону из справочника ячеек",
        ["POST /api/vs/admin/product-weights/upload"] = "Загрузил Excel весов товаров",
        ["POST /api/vs/admin/product-weights/wms"] = "Дозаписал веса из WMS",
        ["DELETE /api/vs/admin/product-weights"] = "Удалил Excel весов товаров",

        ["PUT /api/tsd-settings"] = "Изменил настройки ТСД",
        ["POST /api/tsd-assignments/assign"] = "Выдал ТСД",
        ["POST /api/tsd-assignments/return"] = "Принял ТСД",
        ["POST /api/tsd-assignments/return-tsd"] = "Принял ТСД",
        ["POST /api/tsd/manual-employees"] = "Добавил сотрудника для ТСД",
        ["PUT /api/tsd/manual-employees/{id}"] = "Изменил сотрудника для ТСД",
        ["DELETE /api/tsd/manual-employees/{id}"] = "Удалил сотрудника для ТСД",

        ["POST /api/rk/import-bulk"] = "Загрузил маршруты РК из WMS",
        ["DELETE /api/rk/routes"] = "Удалил маршруты РК за период",
        ["DELETE /api/rk/routes/bulk"] = "Удалил маршруты РК",
        ["PATCH /api/rk/routes/{routeId}/driver"] = "Изменил водителя маршрута",
        ["POST /api/rk/routes/{routeId}/ship"] = "Отгрузил РК",
        ["PUT /api/rk/routes/{routeId}/ship"] = "Исправил отгрузку РК",
        ["POST /api/rk/routes/{routeId}/confirm-ship"] = "Подтвердил отгрузку РК",
        ["POST /api/rk/routes/{routeId}/receive"] = "Принял РК",
        ["PUT /api/rk/routes/{routeId}/receive"] = "Исправил приёмку РК",
        ["POST /api/rk/routes/{routeId}/confirm-receive"] = "Подтвердил приёмку РК",

        ["POST /api/consolidation/complaints"] = "Подал жалобу (консолидация)",
        ["PUT /api/consolidation/complaints/{id}/lookup"] = "Сохранил нарушителя по жалобе",
        ["DELETE /api/consolidation/complaints/{id}"] = "Удалил жалобу",
        ["POST /api/violations"] = "Добавил нарушение (видео)",
        ["DELETE /api/violations/{id}"] = "Удалил нарушение (видео)",
        ["POST /api/zgz/found"] = "Отметил ЕО найденной",
        ["POST /api/zgz/found/delete"] = "Удалил запись о найденной ЕО",
        ["POST /api/zgz/delete"] = "Удалил переводы в ЗГЗ",

        ["POST /api/supply-plans/upload"] = "Загрузил график поставок",
        ["PUT /api/motivation/settings"] = "Изменил настройки мотивации",
        ["POST /api/motivation/people"] = "Добавил людей (мотивация)",
        ["PUT /api/motivation/people/{id:long}"] = "Изменил человека (мотивация)",
        ["DELETE /api/motivation/people/{id:long}"] = "Удалил человека (мотивация)",
    };

    // служебные и «только чтение через POST» — не пишем
    private static readonly HashSet<string> Skip = new()
    {
        "POST /api/vs/auth/ping", "POST /api/vs/mark-updated",
        "POST /api/save-fetched-data", "POST /api/stats/{op}/save", "POST /api/zgz/save",
        "POST /api/date/{date}/storage", "POST /api/rk/routes/{routeId}/eos/refresh", "POST /api/rk/photos",
        "POST /api/wms/products-by-id", "POST /api/stats/receiving/known", "POST /api/supply-plans/facts",
        "POST /api/consolidation/export/report1", "POST /api/consolidation/export/report2",
        "POST /api/reports/stock-consolidation",
    };

    private static readonly Regex Secret = new("pass|token|secret|hash|cookie", RegexOptions.IgnoreCase);
    private const int MaxBodyBytes = 256 * 1024;

    public static async Task EnsureSchemaAsync(NpgsqlConnection conn)
    {
        async Task Exec(string sql) { await using var cmd = new NpgsqlCommand(sql, conn); await cmd.ExecuteNonQueryAsync(); }
        await Exec(@"CREATE TABLE IF NOT EXISTS audit_log (
            id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), warehouse_id TEXT,
            login TEXT, name TEXT, role TEXT, ip TEXT, method TEXT NOT NULL, path TEXT NOT NULL,
            action TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status INT NOT NULL, details JSONB)");
        await Exec("CREATE INDEX IF NOT EXISTS audit_log_wh_at_idx ON audit_log (warehouse_id, at DESC)");
    }

    public static void UseAuditLog(this WebApplication app)
    {
        var connString = app.Configuration["ConnectionStrings:Postgres"]!;
        app.Use(async (ctx, next) =>
        {
            var method = ctx.Request.Method;
            var mutating = HttpMethods.IsPost(method) || HttpMethods.IsPut(method) || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);
            if (!mutating || !(ctx.Request.Path.Value ?? "").StartsWith("/api/")) { await next(); return; }

            // JSON-тело — запомнить, чтобы прочитать после обработки
            var isJson = ctx.Request.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true;
            var captureBody = isJson && ctx.Request.ContentLength is > 0 and <= MaxBodyBytes;
            if (captureBody) ctx.Request.EnableBuffering();
            // выход: после него сессии уже нет — узнаём, чья она, заранее
            VsSession? before = null;
            if (ctx.Request.Path.Value == "/api/vs/auth/logout")
                before = await ctx.RequestServices.GetRequiredService<SessionService>().GetSessionAsync(ctx.Request.Cookies["vs_sid"]);

            await next();

            try
            {
                var template = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText?.TrimEnd('/');
                var key = $"{method} {template ?? ctx.Request.Path.Value}";
                if (Skip.Contains(key)) return;
                if (template == null || template == "/api/{**path}") return; // несуществующий адрес

                var details = new JsonObject();
                foreach (var (k, v) in ctx.Request.RouteValues) details[k] = v?.ToString();
                JsonNode? body = null;
                if (captureBody)
                {
                    ctx.Request.Body.Position = 0;
                    using var reader = new StreamReader(ctx.Request.Body, Encoding.UTF8, leaveOpen: true);
                    try { body = Sanitize(JsonNode.Parse(await reader.ReadToEndAsync())); } catch { /* не JSON */ }
                }
                else if (ctx.Features.Get<IFormFeature>()?.Form is { } form) // форма уже прочитана эндпоинтом
                {
                    var f = new JsonObject();
                    foreach (var (k, v) in form) if (!Secret.IsMatch(k)) f[k] = Trim(v.ToString());
                    if (form.Files.Count > 0)
                        f["files"] = new JsonArray(form.Files.Select(x => (JsonNode)$"{x.FileName} ({Math.Max(1, x.Length / 1024)} КБ)").ToArray());
                    body = f;
                }
                if (body != null) details["body"] = body;

                var session = ctx.Items["vsSession"] as VsSession ?? before;
                // отказ (нет доступа к складу и т.п.) — сессия до эндпоинта не дошла, но кто пытался, видно по cookie
                if (session == null && ctx.Request.Cookies.ContainsKey("vs_sid") && !ctx.Request.Path.StartsWithSegments("/api/vs/auth/logout"))
                    session = await ctx.RequestServices.GetRequiredService<SessionService>().GetSessionAsync(ctx.Request.Cookies["vs_sid"]);
                var login = session?.Login;
                // вход/регистрация: сессии ещё нет — логин из тела
                if (login == null && body is JsonObject bo && bo["login"] is JsonValue lv) login = lv.ToString();
                // вход/выход/регистрация — до выбора склада: без склада, видны на любом
                var warehouse = ctx.Request.Path.StartsWithSegments("/api/vs/auth") ? null : WarehouseContext.Current(ctx);
                var ip = ctx.Request.Headers["X-Forwarded-For"].ToString().Split(',')[0].Trim();
                if (ip == "") ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "";
                var action = Labels.TryGetValue(key, out var label) ? label : key;

                await using var conn = new NpgsqlConnection(connString);
                await conn.OpenAsync();
                await using var cmd = new NpgsqlCommand(@"INSERT INTO audit_log (warehouse_id, login, name, role, ip, method, path, action, summary, status, details)
                    VALUES ($1, $2, (SELECT name FROM vs_users WHERE login = $2), $3, $4, $5, $6, $7, $8, $9, $10::jsonb)", conn);
                cmd.Parameters.AddWithValue((object?)warehouse ?? DBNull.Value);
                cmd.Parameters.AddWithValue((object?)login ?? DBNull.Value);
                cmd.Parameters.AddWithValue((object?)session?.Role ?? DBNull.Value);
                cmd.Parameters.AddWithValue(ip);
                cmd.Parameters.AddWithValue(method);
                cmd.Parameters.AddWithValue(ctx.Request.Path.Value ?? "");
                cmd.Parameters.AddWithValue(action);
                cmd.Parameters.AddWithValue(Summary(details));
                cmd.Parameters.AddWithValue(ctx.Response.StatusCode);
                cmd.Parameters.AddWithValue(details.ToJsonString());
                await cmd.ExecuteNonQueryAsync();
            }
            catch (Exception err) { Console.WriteLine($"[audit] не записано: {err.Message}"); } // журнал не ломает сам запрос
        });
    }

    private static string Trim(string s) => s.Length > 200 ? s[..200] + "…" : s;

    // убрать секреты, сократить длинные строки и списки
    private static JsonNode? Sanitize(JsonNode? n, int depth = 0)
    {
        switch (n)
        {
            case JsonObject o:
                var r = new JsonObject();
                foreach (var (k, v) in o)
                {
                    if (Secret.IsMatch(k)) { r[k] = "***"; continue; }
                    r[k] = depth >= 3 ? (v is JsonArray a ? $"[{a.Count} шт.]" : v is JsonObject ? "{…}" : v?.DeepClone()) : Sanitize(v, depth + 1);
                }
                return r;
            case JsonArray arr:
                if (arr.Count > 5) return $"[{arr.Count} шт.]";
                return new JsonArray(arr.Select(x => Sanitize(x, depth + 1)).ToArray());
            case JsonValue v when v.TryGetValue<string>(out var s):
                return Trim(s);
            default:
                return n?.DeepClone();
        }
    }

    // короткое «что именно» для списка: параметры адреса и узнаваемые поля тела
    private static readonly (string Key, string Label)[] SummaryKeys =
    {
        ("login", ""), ("name", ""), ("fio", ""), ("title", ""), ("label", ""), ("tsd", "ТСД "), ("tsdBarcode", "ТСД "),
        ("address", ""), ("cell", "ячейка "), ("hu", "ЕО "), ("date", ""), ("shift", "смена "), ("status", ""), ("zoneName", "зона "),
    };
    private static string Summary(JsonObject details)
    {
        var parts = new List<string>();
        foreach (var (k, v) in details) if (k != "body" && v != null) parts.Add(v.ToString());
        if (details["body"] is JsonObject b)
        {
            foreach (var (key, label) in SummaryKeys)
                if (b[key] is JsonValue v && v.ToString() is var s && s != "" && !parts.Contains(s))
                    parts.Add(key == "shift" ? (s == "day" ? "дневная смена" : s == "night" ? "ночная смена" : label + s) : label + s);
            if (b["dateFrom"] != null || b["dateTo"] != null) parts.Add($"{b["dateFrom"]} – {b["dateTo"]}");
            foreach (var (k, v) in b)
                if (v is JsonValue sv && sv.TryGetValue<string>(out var s) && s.StartsWith('[') && s.EndsWith("шт.]")) parts.Add($"{k}: {s.Trim('[', ']')}");
                else if (v is JsonArray a && a.Count > 0 && k != "files") parts.Add($"{k}: {a.Count} шт.");
            if (b["files"] is JsonArray files) parts.AddRange(files.Select(f => f?.ToString() ?? ""));
        }
        else if (details["body"] is JsonValue arrCount) parts.Add($"записей: {arrCount.ToString().Trim('[', ']')}");
        var text = string.Join(" · ", parts.Where(p => p.Trim() != ""));
        return text.Length > 300 ? text[..300] + "…" : text;
    }

    // ─── просмотр (Настройки → Журнал, админ) ────────────────────────────────

    public static void MapAuditEndpoints(this WebApplication app)
    {
        app.MapGet("/api/vs/admin/audit", async (string? from, string? to, string? login, string? q, long? beforeId, HttpContext ctx, IConfiguration cfg) =>
        {
            var msk = TimeSpan.FromHours(3);
            DateTimeOffset Day(string? d, DateTimeOffset fallback) =>
                DateOnly.TryParseExact(d ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var x)
                    ? new DateTimeOffset(x.ToDateTime(TimeOnly.MinValue), msk) : fallback;
            var now = DateTimeOffset.UtcNow.ToOffset(msk);
            var fromAt = Day(from, now.Date.AddDays(-7));
            var toAt = Day(to, now.Date).AddDays(1);
            const int limit = 200;
            var wh = WarehouseContext.Current(ctx);

            await using var conn = new NpgsqlConnection(cfg["ConnectionStrings:Postgres"]);
            await conn.OpenAsync();
            // вход/выход — без склада (до выбора склада), их видно на любом складе
            const string where = "(warehouse_id = $1 OR warehouse_id IS NULL) AND at >= $2 AND at < $3";
            await using var cmd = new NpgsqlCommand($@"
                SELECT id, at, login, name, role, ip, action, summary, status, details::text, method, path FROM audit_log
                 WHERE {where} AND ($4 = '' OR login = $4)
                   AND ($5 = '' OR action ILIKE '%' || $5 || '%' OR summary ILIKE '%' || $5 || '%' OR login ILIKE '%' || $5 || '%' OR name ILIKE '%' || $5 || '%')
                   AND ($6::bigint IS NULL OR id < $6)
                 ORDER BY id DESC LIMIT {limit + 1}", conn);
            cmd.Parameters.AddWithValue(wh);
            cmd.Parameters.AddWithValue(fromAt.UtcDateTime);
            cmd.Parameters.AddWithValue(toAt.UtcDateTime);
            cmd.Parameters.AddWithValue(login ?? "");
            cmd.Parameters.AddWithValue((q ?? "").Trim());
            cmd.Parameters.Add(new NpgsqlParameter { Value = (object?)beforeId ?? DBNull.Value, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Bigint });
            var items = new List<object>();
            await using (var r = await cmd.ExecuteReaderAsync())
                while (await r.ReadAsync())
                    items.Add(new
                    {
                        id = r.GetInt64(0), at = r.GetDateTime(1).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
                        login = r.IsDBNull(2) ? null : r.GetString(2), name = r.IsDBNull(3) ? null : r.GetString(3),
                        role = r.IsDBNull(4) ? null : r.GetString(4), ip = r.IsDBNull(5) ? null : r.GetString(5),
                        action = r.GetString(6), summary = r.GetString(7), status = r.GetInt32(8),
                        details = r.IsDBNull(9) ? (JsonElement?)null : JsonDocument.Parse(r.GetString(9)).RootElement.Clone(),
                        method = r.GetString(10), path = r.GetString(11),
                    });
            var hasMore = items.Count > limit;
            if (hasMore) items.RemoveAt(items.Count - 1);

            // кто действовал за период — для фильтра
            var users = new List<object>();
            await using (var u = new NpgsqlCommand($"SELECT login, max(name) FROM audit_log WHERE {where} AND login IS NOT NULL GROUP BY login ORDER BY max(name), login", conn))
            {
                u.Parameters.AddWithValue(wh); u.Parameters.AddWithValue(fromAt.UtcDateTime); u.Parameters.AddWithValue(toAt.UtcDateTime);
                await using var r = await u.ExecuteReaderAsync();
                while (await r.ReadAsync()) users.Add(new { login = r.GetString(0), name = r.IsDBNull(1) ? null : r.GetString(1) });
            }
            return Results.Json(new { items, hasMore, users });
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();
    }
}

// чистка журнала: записи старше года, раз в сутки
public class AuditCleanupService(IConfiguration cfg) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await using var conn = new NpgsqlConnection(cfg["ConnectionStrings:Postgres"]);
                await conn.OpenAsync(stop);
                await using var cmd = new NpgsqlCommand("DELETE FROM audit_log WHERE at < now() - interval '365 days'", conn);
                var n = await cmd.ExecuteNonQueryAsync(stop);
                if (n > 0) Console.WriteLine($"[audit] удалено старых записей: {n}");
            }
            catch (Exception err) when (err is not OperationCanceledException) { Console.WriteLine($"[audit] чистка: {err.Message}"); }
            await Task.Delay(TimeSpan.FromHours(24), stop);
        }
    }
}
