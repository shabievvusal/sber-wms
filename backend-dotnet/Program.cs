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

builder.Services.AddDbContext<AppDbContext>(opt => opt.UseNpgsql(connString));
builder.Services.AddScoped<SessionService>();
builder.Services.AddScoped<RouteService>();
builder.Services.AddScoped<TsdService>();
builder.Services.AddScoped<EmployeeService>();
builder.Services.AddScoped<StatsService>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddSingleton<StockConsolidationService>();
builder.Services.AddSingleton<S3Service>();
builder.Services.AddSingleton<PhotoService>();
builder.Services.AddSingleton<SseService>();

// Тело запроса может быть большим (фото + JSON-импорт маршрутов) — снимаем
// дефолтный лимит Kestrel, конкретный лимит на файл — в PhotoEndpoints.
builder.WebHost.ConfigureKestrel(opt => opt.Limits.MaxRequestBodySize = 50 * 1024 * 1024);

var app = builder.Build();

app.MapGet("/api/dotnet-status", async (AppDbContext db) =>
{
    try
    {
        var count = await db.Database.SqlQueryRaw<long>("SELECT count(*) AS \"Value\" FROM vs_sessions").FirstAsync();
        return Results.Ok(new { ok = true, service = "dotnet", sessions = count });
    }
    catch (Exception ex)
    {
        return Results.Json(new { ok = false, service = "dotnet", error = ex.Message }, statusCode: 503);
    }
});

app.MapRouteEndpoints();
app.MapShipmentEndpoints();
app.MapEoEndpoints();
app.MapDriverEndpoints();
app.MapPhotoEndpoints();
app.MapEventsEndpoints();
app.MapTsdEndpoints();
app.MapEmployeeEndpoints();
app.MapStatsEndpoints();
app.MapAuthEndpoints();
app.MapStockConsolidationEndpoints();

var port = Environment.GetEnvironmentVariable("DOTNET_PORT") ?? "5080";
app.Run($"http://0.0.0.0:{port}");
