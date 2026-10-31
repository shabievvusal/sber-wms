using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Настройки → Веса товаров (только админ), перенесено из Node 2026-10-31.
// Чтение весов (/api/product-weights, /missing) — в StatsEndpoints.
public static class ProductWeightsAdminEndpoints
{
    private const long MaxExcelBytes = 50L * 1024 * 1024;

    public static void MapProductWeightsAdminEndpoints(this WebApplication app)
    {
        var admin = app.MapGroup("/api/vs/admin/product-weights")
            .AddEndpointFilter<VsSessionRequiredFilter>()
            .AddEndpointFilter<VsAdminRequiredFilter>();

        admin.MapGet("/info", async (ProductWeightsService svc) =>
        {
            var file = new FileInfo(ProductWeightsService.ExcelPath);
            if (!file.Exists) return Results.Json(new { exists = false, count = 0 });
            var (count, wmsCount, barcodes) = await svc.CountsAsync();
            return Results.Json(new { exists = true, updatedAt = file.LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), sizeBytes = file.Length, count, wmsCount, barcodes });
        });

        admin.MapPost("/upload", async (HttpContext ctx, ProductWeightsService svc) =>
        {
            var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = MaxExcelBytes + 1024 * 1024;
            if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { error = "Файл не получен" });
            var form = await ctx.Request.ReadFormAsync(new FormOptions { MultipartBodyLengthLimit = MaxExcelBytes + 1024 * 1024 });
            var file = form.Files.GetFile("file");
            if (file == null) return Results.BadRequest(new { error = "Файл не получен" });
            if (!System.Text.RegularExpressions.Regex.IsMatch(file.FileName, @"\.(xlsx|xls)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                return Results.BadRequest(new { error = "Только Excel-файлы (.xlsx, .xls)" });
            if (file.Length > MaxExcelBytes) return Results.BadRequest(new { error = "Файл больше 50 МБ" });
            try
            {
                Directory.CreateDirectory(ProductWeightsService.DataDir);
                // сначала во временный файл: битый Excel не должен затереть рабочий
                var tmp = ProductWeightsService.ExcelPath + ".tmp";
                await using (var fs = File.Create(tmp)) await file.CopyToAsync(fs);
                File.Move(tmp, ProductWeightsService.ExcelPath, overwrite: true);
                var count = await svc.RebuildAsync();
                return Results.Json(new { ok = true, count });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // Веса и штрихкоды, которые браузер дозапросил у WMS (карточка товара)
        // для товаров без веса в Excel: [{ article, grams, productId, name, barcodes, packages: [{ barcode, qty }] }]
        admin.MapPost("/wms", async (JsonElement body, ProductWeightsService svc) =>
        {
            try
            {
                var entries = new List<ProductWeightsService.WmsEntry>();
                if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
                    foreach (var e in items.EnumerateArray())
                    {
                        if (e.ValueKind != JsonValueKind.Object) continue;
                        string Str(string k) => e.TryGetProperty(k, out var v) && v.ValueKind is JsonValueKind.String or JsonValueKind.Number ? v.ToString().Trim() : "";
                        decimal Num(JsonElement x) => x.ValueKind == JsonValueKind.Number && x.TryGetDecimal(out var d) ? d
                            : decimal.TryParse(x.ToString(), System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var p) ? p : 0;
                        var barcodes = e.TryGetProperty("barcodes", out var bc) && bc.ValueKind == JsonValueKind.Array
                            ? bc.EnumerateArray().Select(b => b.ToString()).Where(b => b != "").ToList() : new();
                        var packages = e.TryGetProperty("packages", out var pk) && pk.ValueKind == JsonValueKind.Array
                            ? pk.EnumerateArray().Where(p => p.ValueKind == JsonValueKind.Object)
                                .Select(p => new ProductWeightsService.WmsPackage(p.TryGetProperty("barcode", out var b) ? b.ToString() : "", p.TryGetProperty("qty", out var q) ? Num(q) : 0))
                                .Where(p => p.Barcode != "" && p.Qty > 1).ToList() : new();
                        var productId = Str("productId");
                        entries.Add(new(Str("article"), e.TryGetProperty("grams", out var g) ? Num(g) : 0, productId == "" ? null : productId, Str("name"), barcodes, packages));
                    }
                var saved = await svc.AddWmsAsync(entries);
                var (count, _, _) = await svc.CountsAsync();
                return Results.Json(new { ok = true, saved, count });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // удалить Excel — в справочнике остаются только веса из WMS
        admin.MapDelete("", async (ProductWeightsService svc) =>
        {
            try
            {
                if (File.Exists(ProductWeightsService.ExcelPath)) File.Delete(ProductWeightsService.ExcelPath);
                await svc.RebuildAsync();
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });
    }
}
