using BackendDotnet.Services;
using Microsoft.AspNetCore.Http.Features;

namespace BackendDotnet.Endpoints;

// «Объединение остатков» — сравнение выгрузки остатков по МХ (Excel) с
// выгрузкой задач комплектации (CSV) для выбранного температурного режима,
// см. Services/StockConsolidationService.cs. Рабочий инструмент склада (не
// admin) — только VsSessionRequiredFilter, как остальные отчёты.
//
// Файлы приходят multipart/form-data (по образцу PhotoEndpoints.cs). CSV
// задач может быть большим (~90 МБ в реальной выгрузке) — поднимаем лимит
// размера тела запроса только для этого эндпоинта через
// IHttpMaxRequestBodySizeFeature; глобальный Kestrel-лимит в Program.cs
// (50 МБ) не трогаем, чтобы не затронуть остальные эндпоинты.
public static class StockConsolidationEndpoints
{
    private const long MaxRequestBodySize = 150 * 1024 * 1024; // 150 MB

    public static void MapStockConsolidationEndpoints(this WebApplication app)
    {
        app.MapPost("/api/reports/stock-consolidation", async (HttpRequest request, StockConsolidationService svc) =>
        {
            var sizeFeature = request.HttpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = MaxRequestBodySize;

            if (!request.HasFormContentType)
                return Results.BadRequest(new { error = "Ожидается multipart/form-data" });

            var form = await request.ReadFormAsync();
            var tasksFile = form.Files["tasksCsv"];
            var stockFile = form.Files["stockXlsx"];
            var temperature = form["temperature"].ToString();

            if (tasksFile == null || tasksFile.Length == 0)
                return Results.BadRequest(new { error = "Не передан файл задач комплектации (tasksCsv)" });
            if (stockFile == null || stockFile.Length == 0)
                return Results.BadRequest(new { error = "Не передан файл остатков (stockXlsx)" });
            if (string.IsNullOrEmpty(temperature))
                return Results.BadRequest(new { error = "Не передан температурный режим (temperature)" });

            try
            {
                await using var stockStream = stockFile.OpenReadStream();
                await using var tasksStream = tasksFile.OpenReadStream();
                var result = await svc.ComputeAsync(stockStream, tasksStream, temperature);
                return Results.Json(result);
            }
            catch (Exception err) when (err is ArgumentException or InvalidOperationException)
            {
                return Results.BadRequest(new { error = err.Message });
            }
            catch (Exception err)
            {
                return Results.Json(new { error = err.Message }, statusCode: 500);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
