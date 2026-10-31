using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using BackendDotnet.Data;

namespace BackendDotnet.Endpoints;

// Перенесено из Node 2026-10-31:
//  • POST /api/wms/products-by-id — справочник товаров WMS для «Раскладки КДК».
//    Путь живёт только в API терминала (wmsin-pdt): шлюз отвечает 403 на CORS
//    для любого Origin, а WAF пропускает только «ТСД» по user-agent — поэтому
//    запрос идёт с сервера. Токен WMS — пользователя (заголовок x-wms-token).
//  • GET /api/empl/find-unregistered — исполнители из статистики, которых нет
//    в списке сотрудников (Настройки → Сотрудники). Сопоставление только по ID.
public static class WmsProxyEndpoints
{
    private const string PdtProductsByIdUrl = "https://api.samokat.ru/wmsin-pdt/inbound/products/by-id";
    private static readonly string PdtUserAgent = Environment.GetEnvironmentVariable("WMS_PDT_USER_AGENT") ?? "1686f906-cccc-4caf-9dbd-fd8a2908d17a";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    // список исполнителей тяжёлый (все таблицы операций) — кэш на 5 минут по складу
    private static readonly ConcurrentDictionary<string, (DateTime At, List<ExecutorRow> List)> ExecutorsCache = new();
    private static readonly TimeSpan ExecutorsTtl = TimeSpan.FromMinutes(5);
    public static void InvalidateExecutors() => ExecutorsCache.Clear();

    public class ExecutorRow { public string ExecutorId { get; set; } = ""; public string Fio { get; set; } = ""; }

    public static void MapWmsProxyEndpoints(this WebApplication app)
    {
        app.MapPost("/api/wms/products-by-id", async (HttpContext ctx, JsonElement body) =>
        {
            var token = ctx.Request.Headers["x-wms-token"].ToString();
            if (token == "") return Results.Json(new { error = "Нет WMS-токена" }, statusCode: 400);
            if (!body.TryGetProperty("productIds", out var ids) || ids.ValueKind != JsonValueKind.Array || ids.GetArrayLength() == 0)
                return Results.Json(new { error = "Пустой список productIds" }, statusCode: 400);

            using var req = new HttpRequestMessage(HttpMethod.Post, PdtProductsByIdUrl)
            {
                Content = new StringContent(JsonSerializer.Serialize(new { productIds = ids }), Encoding.UTF8, "application/json"),
            };
            req.Headers.TryAddWithoutValidation("Accept", "application/json, text/plain, */*");
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
            req.Headers.TryAddWithoutValidation("User-Agent", PdtUserAgent);
            try
            {
                using var r = await Http.SendAsync(req);
                var text = await r.Content.ReadAsStringAsync();
                JsonElement data;
                try { data = text == "" ? default : JsonSerializer.Deserialize<JsonElement>(text); }
                catch { return Results.Json(new { error = $"WMS вернул не JSON ({(int)r.StatusCode}): {text[..Math.Min(150, text.Length)]}" }, statusCode: 502); }
                if (!r.IsSuccessStatusCode)
                {
                    var msg = data.ValueKind == JsonValueKind.Object && (data.TryGetProperty("error", out var e) || data.TryGetProperty("message", out e)) ? e.ToString() : $"WMS {(int)r.StatusCode}";
                    return Results.Json(new { error = msg }, statusCode: (int)r.StatusCode);
                }
                return Results.Text(text, "application/json");
            }
            catch (TaskCanceledException) { return Results.Json(new { error = "WMS не ответил за 30 секунд" }, statusCode: 504); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 502); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapGet("/api/empl/find-unregistered", async (AppDbContext db) =>
        {
            try
            {
                var wh = db.WarehouseId;
                List<ExecutorRow> all;
                if (ExecutorsCache.TryGetValue(wh, out var c) && DateTime.UtcNow - c.At < ExecutorsTtl) all = c.List;
                else
                {
                    // исполнители из всех таблиц операций (ФИО — самое длинное написание)
                    var tables = new[] { "wms_ops", "wms_placement", "wms_stock_moves", "wms_receiving", "wms_remains" };
                    var union = string.Join(" UNION ", tables.Select(t => $"SELECT executor_id, executor FROM {t} WHERE warehouse_id = @wh AND executor_id <> '' AND executor <> ''"));
                    all = await db.Database.SqlQueryRaw<ExecutorRow>($@"
                        SELECT executor_id AS ""ExecutorId"", (array_agg(executor ORDER BY length(executor) DESC, executor))[1] AS ""Fio""
                          FROM ({union}) AS e GROUP BY executor_id", new NpgsqlParameter("wh", wh)).ToListAsync();
                    ExecutorsCache[wh] = (DateTime.UtcNow, all);
                }
                var known = (await db.Database.SqlQueryRaw<string>(
                    "SELECT executor_id AS \"Value\" FROM employees WHERE warehouse_id = @wh AND executor_id IS NOT NULL AND executor_id <> ''",
                    new NpgsqlParameter("wh", wh)).ToListAsync()).ToHashSet();
                var employees = all.Where(e => !known.Contains(e.ExecutorId))
                    .OrderBy(e => e.Fio, StringComparer.Create(new System.Globalization.CultureInfo("ru-RU"), false))
                    .Select(e => new { executorId = e.ExecutorId, fio = e.Fio });
                return Results.Json(new { employees });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
