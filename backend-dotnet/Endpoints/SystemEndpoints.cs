using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BackendDotnet.Data;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Служебное (перенесено из Node 2026-10-31): статус «Обновлено» и запрос
// обновления данных, настройки автообновления, перекличка мониторинга.
// Данные — в app_state (AppStateService), те же ключи, что были у Node.
public static class SystemEndpoints
{
    private static readonly string[] DefaultFullRefreshTimes = { "09:10", "21:10" };
    private const int DefaultIncrementalMinutes = 30;
    private const int DefaultIncrementalLookbackMinutes = 40;

    // как normalizeAutoFetchSettings в Node: время ЧЧ:ММ без повторов, интервалы 5–240 мин
    private static JsonObject NormalizeAutoFetch(JsonNode? input)
    {
        var times = new List<string>();
        var raw = input?["fullRefreshTimes"];
        IEnumerable<string> rawTimes = raw is JsonArray arr
            ? arr.Select(x => x?.ToString() ?? "")
            : (raw?.ToString() ?? "").Split(',');
        foreach (var t in rawTimes)
        {
            var m = Regex.Match(t.Trim(), @"^(\d{1,2}):(\d{2})$");
            if (!m.Success) continue;
            int hh = int.Parse(m.Groups[1].Value), mm = int.Parse(m.Groups[2].Value);
            if (hh > 23 || mm > 59) continue;
            var norm = $"{hh:00}:{mm:00}";
            if (!times.Contains(norm)) times.Add(norm);
        }
        int Clamp(string key, int def)
        {
            var node = input?[key];
            var v = node != null && double.TryParse(node.ToString(), System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var d) && d != 0 ? (int)d : def;
            return Math.Max(5, Math.Min(240, v));
        }
        return new JsonObject
        {
            ["fullRefreshTimes"] = new JsonArray((times.Count > 0 ? times : DefaultFullRefreshTimes.ToList()).Select(x => (JsonNode)x!).ToArray()),
            ["incrementalMinutes"] = Clamp("incrementalMinutes", DefaultIncrementalMinutes),
            ["incrementalLookbackMinutes"] = Clamp("incrementalLookbackMinutes", DefaultIncrementalLookbackMinutes),
        };
    }

    public static void MapSystemEndpoints(this WebApplication app)
    {
        // «Обновлено» и флаг запроса — тулбар статистики опрашивает без входа не
        // нужно, но статус безопасен: только время и флаг, без настроек.
        app.MapGet("/api/status", async (HttpContext ctx, AppStateService state, FetchRequestService fetch) =>
        {
            var lastRun = (await state.GetAsync("last-run"))?["lastRun"]?.ToString();
            return Results.Json(new { lastRun, fetchRequested = fetch.IsRequested(WarehouseContext.Current(ctx)) });
        });

        app.MapPost("/api/vs/request-fetch", (HttpContext ctx, FetchRequestService fetch) =>
        {
            fetch.Request(WarehouseContext.Current(ctx));
            return Results.Json(new { ok = true });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // устройство с автообновлением закончило полную выгрузку
        app.MapPost("/api/vs/mark-updated", async (HttpContext ctx, AppStateService state, FetchRequestService fetch) =>
        {
            await state.SetAsync("last-run", new JsonObject { ["lastRun"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") });
            fetch.Clear(WarehouseContext.Current(ctx));
            return Results.Json(new { ok = true });
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapGet("/api/vs/auto-fetch-settings", async (AppStateService state) =>
            Results.Json(NormalizeAutoFetch(await state.GetAsync("auto-fetch-settings"))))
            .AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPut("/api/vs/admin/auto-fetch-settings", async (JsonNode? body, AppStateService state) =>
        {
            var normalized = NormalizeAutoFetch(body);
            await state.SetAsync("auto-fetch-settings", normalized);
            return Results.Json(normalized);
        }).AddEndpointFilter<VsSessionRequiredFilter>().AddEndpointFilter<VsAdminRequiredFilter>();

        // перекличка мониторинга: кто на смене
        app.MapGet("/api/rollcall", async (AppStateService state) =>
            Results.Json((JsonNode?)await state.GetAsync("rollcall") ?? new JsonObject { ["shiftKey"] = null, ["present"] = new JsonArray() }))
            .AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapPut("/api/rollcall", async (JsonNode? body, AppStateService state) =>
        {
            var shiftKey = body?["shiftKey"]?.ToString();
            var present = body?["present"] as JsonArray;
            await state.SetAsync("rollcall", new JsonObject
            {
                ["shiftKey"] = string.IsNullOrEmpty(shiftKey) ? null : shiftKey,
                ["present"] = present?.DeepClone() ?? new JsonArray(),
            });
            return Results.Json(new { ok = true });
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
