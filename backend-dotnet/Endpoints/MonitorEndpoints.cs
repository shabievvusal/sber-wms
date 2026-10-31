using System.Text.Json;
using System.Text.Json.Nodes;
using BackendDotnet.Data;

namespace BackendDotnet.Endpoints;

// «ЕО в работе» через сервер (перенесено из Node 2026-10-31) — когда в
// браузере нет своего токена WMS. Токен сервера (и cookie, если нужен) —
// в config.json тома node-persist (CONFIG_PATH), правится вручную на сервере.
public static class MonitorEndpoints
{
    private const string LiveMonitorUrl = "https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/handling-units-in-progress";
    private const string FeaturesUrl = "https://api.samokat.ru/wmsops-wwh/warehouses/features-configuration";
    private static readonly string ConfigPath = Environment.GetEnvironmentVariable("CONFIG_PATH") ?? "/data/node-persist/config.json";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    private static (string Token, string Cookie) LoadConfig()
    {
        try
        {
            var cfg = JsonNode.Parse(File.ReadAllText(ConfigPath)) as JsonObject;
            return ((cfg?["token"]?.ToString() ?? "").Trim(), (cfg?["cookie"]?.ToString() ?? "").Trim());
        }
        catch { return ("", ""); }
    }

    private static HttpRequestMessage WmsRequest(string url, string token, string cookie = "")
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("Accept", "application/json");
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        req.Headers.TryAddWithoutValidation("Origin", "https://wwh.samokat.ru");
        req.Headers.TryAddWithoutValidation("Referer", "https://wwh.samokat.ru/");
        req.Headers.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36");
        if (cookie != "") req.Headers.TryAddWithoutValidation("Cookie", cookie);
        return req;
    }

    // склад, выбранный в WMS у учётки токена (null — не удалось узнать)
    private static async Task<string?> TokenWarehouseAsync(string token)
    {
        try
        {
            using var req = WmsRequest(FeaturesUrl, token);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            using var r = await Http.SendAsync(req, cts.Token);
            if (!r.IsSuccessStatusCode) return null;
            var data = JsonNode.Parse(await r.Content.ReadAsStringAsync());
            return data?["value"]?["warehouseId"]?.ToString();
        }
        catch { return null; }
    }

    public static void MapMonitorEndpoints(this WebApplication app)
    {
        app.MapGet("/api/monitor/live", async (HttpContext ctx) =>
        {
            try
            {
                var (token, cookie) = LoadConfig();
                if (token == "") return Results.Json(new { error = "Токен не задан" }, statusCode: 401);
                // данные другого склада под выбранным на сайте не показываем
                var tokenWarehouse = await TokenWarehouseAsync(token);
                if (tokenWarehouse != null && tokenWarehouse != WarehouseContext.Current(ctx))
                    return Results.Json(new { error = "Серверный токен WMS настроен на другой склад" }, statusCode: 409);
                using var req = WmsRequest(LiveMonitorUrl, token, cookie);
                using var r = await Http.SendAsync(req);
                var text = await r.Content.ReadAsStringAsync();
                JsonElement data;
                try { data = JsonSerializer.Deserialize<JsonElement>(text); }
                catch { return Results.Json(new { error = "Ответ не JSON", preview = text[..Math.Min(200, text.Length)] }, statusCode: 502); }
                if (!r.IsSuccessStatusCode) return Results.Json(new { error = $"API {(int)r.StatusCode}", data }, statusCode: (int)r.StatusCode);
                return Results.Text(text, "application/json");
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 502); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
