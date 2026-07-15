using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Агрегации по водителям/ЦФЗ + долг рохлей. driver-rokhlya-debt/drivers/pending/
// unshipped и их routes/* — публичные (страница кладовщика), как в оригинале;
// только /drivers и /cfz требуют сессию.
public static class DriverEndpoints
{
    public static void MapDriverEndpoints(this WebApplication app)
    {
        app.MapGet("/api/rk/driver-rokhlya-debt", async (string? name, RouteService svc) =>
        {
            try
            {
                var trimmed = (name ?? "").Trim();
                if (string.IsNullOrEmpty(trimmed)) return Results.Json(new { rokhlyaDebt = 0, debtSince = (object?)null });
                return Results.Json(await svc.GetDriverRokhlyaDebtAsync(trimmed));
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        });

        app.MapGet("/api/rk/drivers", async (string? q, RouteService svc) =>
        {
            try { return Results.Json(await svc.GetByDriverAsync(q)); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapGet("/api/rk/drivers/pending", async (string? q, RouteService svc) =>
        {
            try { return Results.Json(await svc.GetDriversWithPendingAsync(q ?? "")); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/rk/drivers/{name}/routes/pending", async (string name, RouteService svc) =>
        {
            try { return Results.Json(await svc.GetRoutesByDriverPendingAsync(Uri.UnescapeDataString(name))); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/rk/drivers/unshipped", async (string? q, RouteService svc) =>
        {
            try { return Results.Json(await svc.GetDriversUnshippedAsync(q ?? "")); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/rk/drivers/{name}/routes/unshipped", async (string name, RouteService svc) =>
        {
            try { return Results.Json(await svc.GetRoutesByDriverUnshippedAsync(Uri.UnescapeDataString(name))); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/rk/cfz", async (string? q, RouteService svc) =>
        {
            try { return Results.Json(await svc.GetByCfzAsync(q)); }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
