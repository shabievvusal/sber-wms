// Trek 2. Фаза 0 — health-check (/api/dotnet-status), сохранён как есть.
// Фаза 1 — первый настоящий бизнес-модуль: полный перенос route-rk-pg.js
// (backend/) сюда — те же таблицы `routes`/`vs_sessions`/`vs_users` в базе
// `zlp`, тот же JSON-контракт, что и у Node (camelCase, см. Json/JsonOptions.cs).
using Microsoft.EntityFrameworkCore;
using Npgsql;
using BackendDotnet.Data;
using BackendDotnet.Endpoints;
using BackendDotnet.Json;
using BackendDotnet.Services;

var builder = WebApplication.CreateBuilder(args);

var pgHost = Environment.GetEnvironmentVariable("PG_HOST") ?? "postgres";
var pgPort = Environment.GetEnvironmentVariable("PG_PORT") ?? "5432";
var pgDb = Environment.GetEnvironmentVariable("PG_DB") ?? "zlp";
var pgUser = Environment.GetEnvironmentVariable("PG_USER") ?? "zlp";
var pgPassword = Environment.GetEnvironmentVariable("PG_PASSWORD") ?? "";
var connString = new NpgsqlConnectionStringBuilder
{
    Host = pgHost,
    Port = int.Parse(pgPort),
    Database = pgDb,
    Username = pgUser,
    Password = pgPassword,
}.ConnectionString;
builder.Configuration["ConnectionStrings:Postgres"] = connString;

// camelCase везде — тот же JSON-контракт, что Node всегда отдавал
// (routeId, shippedRK и т.д.), см. Json/JsonOptions.cs.
builder.Services.ConfigureHttpJsonOptions(opt =>
{
    opt.SerializerOptions.PropertyNamingPolicy = JsonOptions.Default.PropertyNamingPolicy;
});

builder.Services.AddHttpContextAccessor();
builder.Services.AddDbContext<AppDbContext>(opt => opt.UseNpgsql(connString));
builder.Services.AddScoped<SessionService>();
builder.Services.AddScoped<RouteService>();
builder.Services.AddScoped<TsdService>();
builder.Services.AddScoped<EmployeeService>();
builder.Services.AddScoped<AccountCheckService>();
builder.Services.AddScoped<StatsService>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddScoped<WarehouseService>();
builder.Services.AddScoped<MotivationService>();
builder.Services.AddScoped<ZgzService>();
builder.Services.AddScoped<AppStateService>();
builder.Services.AddSingleton<FetchRequestService>();
builder.Services.AddScoped<CellStoreService>();
builder.Services.AddSingleton<StockConsolidationService>();
builder.Services.AddSingleton<PhotoService>();

// Тело запроса может быть большим (фото + JSON-импорт маршрутов) — снимаем
// дефолтный лимит Kestrel, конкретный лимит на файл — в PhotoEndpoints.
builder.WebHost.ConfigureKestrel(opt => opt.Limits.MaxRequestBodySize = 50 * 1024 * 1024);

var app = builder.Build();

// данные по складам: столбец warehouse_id и ключи со складом (один раз)
await WarehouseSchema.EnsureAsync(connString);
// склад запроса (заголовок X-Warehouse) — до всех эндпоинтов
app.UseWarehouseContext();
// после записи выгрузки WMS (WmsSaveEndpoints) — новые
// исполнители сразу видны в «Настройки → Сотрудники» (find-unregistered)
app.Use(async (ctx, next) =>
{
    await next();
    var p = ctx.Request.Path.Value ?? "";
    if (HttpMethods.IsPost(ctx.Request.Method) && ctx.Response.StatusCode < 300
        && (p == "/api/save-fetched-data" || (p.StartsWith("/api/stats/") && p.EndsWith("/save"))))
        BackendDotnet.Endpoints.WmsProxyEndpoints.InvalidateExecutors();
});

app.MapRouteEndpoints();
app.MapShipmentEndpoints();
app.MapEoEndpoints();
app.MapDriverEndpoints();
app.MapPhotoEndpoints();
app.MapTsdEndpoints();
app.MapEmployeeEndpoints();
app.MapStatsEndpoints();
app.MapAuthEndpoints();
app.MapStockConsolidationEndpoints();
app.MapMotivationEndpoints();
app.MapZgzEndpoints();
app.MapSystemEndpoints();
app.MapViolationEndpoints();
app.MapWmsProxyEndpoints();
app.MapWmsSaveEndpoints();
app.MapCellStoreEndpoints();

var port = Environment.GetEnvironmentVariable("DOTNET_PORT") ?? "5080";
app.Run($"http://0.0.0.0:{port}");
