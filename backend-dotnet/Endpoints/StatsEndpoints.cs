using System.Text.Json;
using BackendDotnet.Models;
using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// Порт статистики/агрегаций (storage.js, Фаза 3) — 4 домена (ops/placement/
// receiving/remains) + смены + monthly-company/monthly-employees/
// employee-rates + product-weights (чтение). Гейтинг сессией — 1-в-1 с
// оригиналом (vsSessionOptional/vsSessionRequired/публичные маршруты).
//
// /api/stats/*/ingest — НЕ проксируются через Caddy наружу (нет в
// Caddyfile), вызываются только Node напрямую (dotnet:5080) как часть
// дуал-райта (ops) — см. PLAN.md. Без гейтинга сессией: доверенный
// server-to-server вызов внутри docker-сети, не достижим извне.
public static class StatsEndpoints
{
    public static void MapStatsEndpoints(this WebApplication app)
    {
        // ─── Ops: чтение ────────────────────────────────────────────────────

        app.MapGet("/api/date/{date}/items", async (string date, int? fromHour, int? toHour, string? shift, HttpContext ctx, StatsService svc, SessionService sessions) =>
        {
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(date, @"^\d{4}-\d{2}-\d{2}$"))
                    return Results.Json(new { error = "Неверный формат даты (YYYY-MM-DD)" }, statusCode: 400);
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                if (session?.Role == "supervisor" && !string.IsNullOrEmpty(session.ShiftType))
                {
                    if (normalizedShift != null && normalizedShift != session.ShiftType)
                        return Results.Json(new { error = "Доступ только к своей смене" }, statusCode: 403);
                    normalizedShift = session.ShiftType;
                }
                var items = await svc.GetDateItemsAsync(date, fromHour, toHour, normalizedShift);
                var idMap = await svc.GetIdMapAsync();

                if (session?.Role == "manager" && session.CompanyIds is { Count: > 0 })
                {
                    var allowed = new HashSet<string>(session.CompanyIds.Select(c => c.Trim().ToLowerInvariant()));
                    items = items.Where(it =>
                    {
                        var company = idMap.TryGetValue(it.ExecutorId ?? "", out var c) ? c : null;
                        return !string.IsNullOrEmpty(company) && allowed.Contains(company.Trim().ToLowerInvariant());
                    }).ToList();
                }
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                if (user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name))
                {
                    var selfNorm = NormalizeFioForMatch(user.Name);
                    items = items.Where(it => NormalizeFioForMatch(it.Executor) == selfNorm).ToList();
                }
                if (user?.VisibleCompanies is { Count: > 0 })
                {
                    var allowed = new HashSet<string>(user.VisibleCompanies.Select(c => c.Trim().ToLowerInvariant()));
                    items = items.Where(it =>
                    {
                        var company = idMap.TryGetValue(it.ExecutorId ?? "", out var c) ? c : null;
                        return !string.IsNullOrEmpty(company) && allowed.Contains(company.Trim().ToLowerInvariant());
                    }).ToList();
                }
                return Results.Json(new { date, count = items.Count, items });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/date/{date}/summary", async (string date, string? shift, int? idleThresholdMinutes, HttpContext ctx, StatsService svc, SessionService sessions) =>
        {
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(date, @"^\d{4}-\d{2}-\d{2}$"))
                    return Results.Json(new { error = "Неверный формат даты (YYYY-MM-DD)" }, statusCode: 400);
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                long? idleThresholdMs = idleThresholdMinutes is >= 0 ? idleThresholdMinutes.Value * 60 * 1000 : null;
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                if (session?.Role == "supervisor" && !string.IsNullOrEmpty(session.ShiftType))
                {
                    if (normalizedShift != null && normalizedShift != session.ShiftType)
                        return Results.Json(new { error = "Доступ только к своей смене" }, statusCode: 403);
                    normalizedShift = session.ShiftType;
                }
                var idMap = await svc.GetIdMapAsync();
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                var filterExecutorNorm = user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name) ? NormalizeFioForMatch(user.Name) : null;
                var filterCompanies = user?.VisibleCompanies is { Count: > 0 } ? user.VisibleCompanies : null;
                var summary = await svc.GetDateSummaryAsync(date, normalizedShift, idleThresholdMs, filterExecutorNorm, filterCompanies, idMap);
                return Results.Json(new { date, shift = (object?)normalizedShift, totalOps = summary.TotalOps, totalQty = summary.TotalQty, executors = summary.Executors, hourly = summary.Hourly, firstAt = summary.FirstAt, lastAt = summary.LastAt, companySummary = summary.CompanySummary, hourlyByEmployee = summary.HourlyByEmployee, idlesByEmployee = summary.IdlesByEmployee, totalWeightStorageGrams = summary.TotalWeightStorageGrams, totalWeightKdkGrams = summary.TotalWeightKdkGrams, totalWeightGrams = summary.TotalWeightGrams, weightByEmployee = summary.WeightByEmployee, weightByCompany = summary.WeightByCompany, missingWeightNames = summary.MissingWeightNames, missingWeightItems = summary.MissingWeightItems });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapPost("/api/date/{date}/storage", async (string date, SaveStorageRequest body, StatsService svc) =>
        {
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(date, @"^\d{4}-\d{2}-\d{2}$"))
                    return Results.Json(new { error = "Неверный формат даты (YYYY-MM-DD)" }, statusCode: 400);
                await svc.SaveStorageForDateAsync(date, body);
                var shift = body.Shift == "night" ? "night" : "day";
                return Results.Json(new { ok = true, date, shift });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // ─── Ops: приём данных (внутренний, дуал-райт из Node) ─────────────

        app.MapPost("/api/stats/ops/ingest", async (OpsIngestRequest body, StatsService svc) =>
        {
            try
            {
                var items = body.Items ?? (body.Value.HasValue && body.Value.Value.TryGetProperty("items", out var itemsEl) && itemsEl.ValueKind == JsonValueKind.Array
                    ? itemsEl.EnumerateArray().ToList() : new List<JsonElement>());
                var added = await svc.IngestOpsAsync(items);
                return Results.Json(new { ok = true, added });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        // ─── Placement ──────────────────────────────────────────────────────

        app.MapPost("/api/stats/placement/ingest", async (PlacementSaveRequest body, StatsService svc) =>
        {
            try
            {
                var (added, skipped) = await svc.SavePlacementItemsAsync(body.Items ?? new());
                return Results.Json(new { ok = true, added, skipped });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/date/{date}/placement/summary", async (string date, int? fromHour, int? toHour, string? shift, HttpContext ctx, StatsService svc, SessionService sessions) =>
        {
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(date, @"^\d{4}-\d{2}-\d{2}$"))
                    return Results.Json(new { error = "Неверный формат даты (YYYY-MM-DD)" }, statusCode: 400);
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                if (session?.Role == "supervisor" && !string.IsNullOrEmpty(session.ShiftType))
                {
                    if (normalizedShift != null && normalizedShift != session.ShiftType)
                        return Results.Json(new { error = "Доступ только к своей смене" }, statusCode: 403);
                    normalizedShift = session.ShiftType;
                }
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                var filterExecutorNorm = user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name) ? NormalizeFioForMatch(user.Name) : null;
                var filterCompanies = user?.VisibleCompanies is { Count: > 0 } ? user.VisibleCompanies : null;
                var idMap = await svc.GetIdMapAsync();
                var summary = await svc.GetPlacementSummaryAsync(date, fromHour, toHour, normalizedShift, filterExecutorNorm, filterCompanies, idMap);
                return Results.Json(Merge(new { date, shift = (object?)normalizedShift }, summary));
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/stats/placement/monthly-employees", async (string? dateFrom, string? dateTo, string? shift, StatsService svc, SessionService sessions, HttpContext ctx) =>
        {
            try
            {
                var from = (dateFrom ?? "").Length >= 10 ? dateFrom![..10] : (dateFrom ?? "");
                var to = (dateTo ?? "").Length >= 10 ? dateTo![..10] : (dateTo ?? "");
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var dates = StatsService.GetDateRangeList(from, to);
                if (dates.Count == 0) return Results.Json(new { error = "Неверный диапазон дат" }, statusCode: 400);
                var idMap = await svc.GetIdMapAsync();
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                var filterExecutorNorm = user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name) ? NormalizeFioForMatch(user.Name) : null;
                var filterCompanies = user?.VisibleCompanies is { Count: > 0 } ? user.VisibleCompanies : null;
                var rows = new List<object>();
                foreach (var dateStr in dates)
                {
                    var summary = (dynamic)await svc.GetPlacementSummaryAsync(dateStr, null, null, normalizedShift, filterExecutorNorm, filterCompanies, idMap);
                    var hb = summary.hourlyByEmployee;
                    foreach (var row in hb.rows)
                    {
                        var byHour = (Dictionary<string, int>)row.byHour;
                        var hoursCount = byHour.Values.Count(v => v > 0);
                        rows.Add(new { date = dateStr, company = row.company ?? "—", name = row.name, total = row.total is int t ? t : 0, workedMinutes = hoursCount * 60, firstAt = row.firstAt, lastAt = row.lastAt });
                    }
                }
                return Results.Json(new { dateFrom = from, dateTo = to, shift = (object?)normalizedShift, rows });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // ─── Receiving ──────────────────────────────────────────────────────

        app.MapPost("/api/stats/receiving/ingest", async (ReceivingSaveRequest body, StatsService svc) =>
        {
            try
            {
                var (added, skipped) = await svc.SaveReceivingItemsAsync(body.Items ?? new());
                return Results.Json(new { ok = true, added, skipped });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/date/{date}/receiving/summary", async (string date, int? fromHour, int? toHour, string? shift, HttpContext ctx, StatsService svc, SessionService sessions) =>
        {
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(date, @"^\d{4}-\d{2}-\d{2}$"))
                    return Results.Json(new { error = "Неверный формат даты (YYYY-MM-DD)" }, statusCode: 400);
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                if (session?.Role == "supervisor" && !string.IsNullOrEmpty(session.ShiftType))
                {
                    if (normalizedShift != null && normalizedShift != session.ShiftType)
                        return Results.Json(new { error = "Доступ только к своей смене" }, statusCode: 403);
                    normalizedShift = session.ShiftType;
                }
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                var filterExecutorNorm = user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name) ? NormalizeFioForMatch(user.Name) : null;
                var filterCompanies = user?.VisibleCompanies is { Count: > 0 } ? user.VisibleCompanies : null;
                var idMap = await svc.GetIdMapAsync();
                var summary = await svc.GetReceivingSummaryAsync(date, fromHour, toHour, normalizedShift, filterExecutorNorm, filterCompanies, idMap);
                return Results.Json(Merge(new { date, shift = (object?)normalizedShift }, summary));
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/stats/receiving/monthly-employees", async (string? dateFrom, string? dateTo, string? shift, StatsService svc, SessionService sessions, HttpContext ctx) =>
        {
            try
            {
                var from = (dateFrom ?? "").Length >= 10 ? dateFrom![..10] : (dateFrom ?? "");
                var to = (dateTo ?? "").Length >= 10 ? dateTo![..10] : (dateTo ?? "");
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var dates = StatsService.GetDateRangeList(from, to);
                if (dates.Count == 0) return Results.Json(new { error = "Неверный диапазон дат" }, statusCode: 400);
                var idMap = await svc.GetIdMapAsync();
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                var filterExecutorNorm = user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name) ? NormalizeFioForMatch(user.Name) : null;
                var filterCompanies = user?.VisibleCompanies is { Count: > 0 } ? user.VisibleCompanies : null;
                var rows = new List<object>();
                foreach (var dateStr in dates)
                {
                    var summary = (dynamic)await svc.GetReceivingSummaryAsync(dateStr, null, null, normalizedShift, filterExecutorNorm, filterCompanies, idMap);
                    var hb = summary.hourlyByEmployee;
                    foreach (var row in hb.rows)
                    {
                        var byHour = (Dictionary<string, int>)row.byHour;
                        var hoursCount = byHour.Values.Count(v => v > 0);
                        rows.Add(new { date = dateStr, company = row.company ?? "—", name = row.name, total = row.total is int t ? t : 0, workedMinutes = hoursCount * 60, firstAt = row.firstAt, lastAt = row.lastAt });
                    }
                }
                return Results.Json(new { dateFrom = from, dateTo = to, shift = (object?)normalizedShift, rows });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // ─── Remains ────────────────────────────────────────────────────────

        app.MapPost("/api/stats/remains/ingest", async (RemainsSaveRequest body, StatsService svc) =>
        {
            try
            {
                var (added, skipped) = await svc.SaveRemainsItemsAsync(body.Items ?? new());
                return Results.Json(new { ok = true, added, skipped });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/date/{date}/remains/summary", async (string date, int? fromHour, int? toHour, string? shift, HttpContext ctx, StatsService svc, SessionService sessions) =>
        {
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(date, @"^\d{4}-\d{2}-\d{2}$"))
                    return Results.Json(new { error = "Неверный формат даты (YYYY-MM-DD)" }, statusCode: 400);
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                if (session?.Role == "supervisor" && !string.IsNullOrEmpty(session.ShiftType))
                {
                    if (normalizedShift != null && normalizedShift != session.ShiftType)
                        return Results.Json(new { error = "Доступ только к своей смене" }, statusCode: 403);
                    normalizedShift = session.ShiftType;
                }
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                var filterExecutorNorm = user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name) ? NormalizeFioForMatch(user.Name) : null;
                var filterCompanies = user?.VisibleCompanies is { Count: > 0 } ? user.VisibleCompanies : null;
                var idMap = await svc.GetIdMapAsync();
                var summary = await svc.GetRemainsSummaryAsync(date, fromHour, toHour, normalizedShift, filterExecutorNorm, filterCompanies, idMap);
                return Results.Json(Merge(new { date, shift = (object?)normalizedShift }, summary));
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/stats/remains/monthly-employees", async (string? dateFrom, string? dateTo, string? shift, StatsService svc, SessionService sessions, HttpContext ctx) =>
        {
            try
            {
                var from = (dateFrom ?? "").Length >= 10 ? dateFrom![..10] : (dateFrom ?? "");
                var to = (dateTo ?? "").Length >= 10 ? dateTo![..10] : (dateTo ?? "");
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var dates = StatsService.GetDateRangeList(from, to);
                if (dates.Count == 0) return Results.Json(new { error = "Неверный диапазон дат" }, statusCode: 400);
                var idMap = await svc.GetIdMapAsync();
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                var filterExecutorNorm = user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name) ? NormalizeFioForMatch(user.Name) : null;
                var filterCompanies = user?.VisibleCompanies is { Count: > 0 } ? user.VisibleCompanies : null;
                var rows = new List<object>();
                foreach (var dateStr in dates)
                {
                    var summary = (dynamic)await svc.GetRemainsSummaryAsync(dateStr, null, null, normalizedShift, filterExecutorNorm, filterCompanies, idMap);
                    var hb = summary.hourlyByEmployee;
                    foreach (var row in hb.rows)
                    {
                        var byHour = (Dictionary<string, int>)row.byHour;
                        var hoursCount = byHour.Values.Count(v => v > 0);
                        rows.Add(new { date = dateStr, company = row.company ?? "—", name = row.name, total = row.total is int t ? t : 0, workedMinutes = hoursCount * 60, firstAt = row.firstAt, lastAt = row.lastAt });
                    }
                }
                return Results.Json(new { dateFrom = from, dateTo = to, shift = (object?)normalizedShift, rows });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // ─── Смены ──────────────────────────────────────────────────────────

        app.MapGet("/api/shifts", async (HttpContext ctx, StatsService svc, SessionService sessions) =>
        {
            try
            {
                var shifts = await svc.ListShiftsAsync();
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                if (session?.Role == "supervisor" && !string.IsNullOrEmpty(session.ShiftType))
                {
                    shifts = shifts.Where(s => ((dynamic)s).shiftKey is string sk && sk.EndsWith("_" + session.ShiftType)).ToList();
                }
                return Results.Json(shifts);
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/shifts/current", (StatsService svc) => Results.Json(new { shiftKey = svc.GetCurrentShiftKey() }));

        app.MapGet("/api/shifts/{shiftKey}/items", async (string shiftKey, StatsService svc) =>
        {
            try
            {
                if (!System.Text.RegularExpressions.Regex.IsMatch(shiftKey, @"^\d{4}-\d{2}-\d{2}_(day|night)$"))
                    return Results.Json(new { error = "Неверный формат shiftKey" }, statusCode: 400);
                var items = await svc.GetShiftItemsAsync(shiftKey);
                return Results.Json(new { shiftKey, count = items.Count, items });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // ─── Анализ: employee-rates / monthly-company / monthly-employees ──

        app.MapGet("/api/analysis/employee-rates", async (string? dateFrom, string? dateTo, string? shift, int? idleThresholdMinutes, HttpContext ctx, StatsService svc, SessionService sessions) =>
        {
            try
            {
                var from = (dateFrom ?? "").Length >= 10 ? dateFrom![..10] : (dateFrom ?? "");
                var to = (dateTo ?? "").Length >= 10 ? dateTo![..10] : (dateTo ?? "");
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var idleThresholdMs = idleThresholdMinutes is >= 0 ? idleThresholdMinutes.Value * 60 * 1000 : 15 * 60 * 1000;
                var dates = StatsService.GetDateRangeList(from, to);
                if (dates.Count == 0) return Results.Json(new { error = "Неверный диапазон дат" }, statusCode: 400);
                var idMap = await svc.GetIdMapAsync();
                var session = await sessions.GetSessionFromCookieAsync(ctx.Request);
                var user = session != null ? await sessions.FindUserByLoginAsync(session.Login) : null;
                var filterExecutorNorm = user is { SelfOnly: true } && !string.IsNullOrEmpty(user.Name) ? NormalizeFioForMatch(user.Name) : null;
                var filterCompanies = user?.VisibleCompanies is { Count: > 0 } ? user.VisibleCompanies : null;
                var result = await svc.GetEmployeeRatesAsync(from, to, normalizedShift, idleThresholdMs, filterExecutorNorm, filterCompanies, idMap);
                return Results.Json(result);
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        app.MapGet("/api/stats/monthly-company", async (int? year, int? month, string? shift, StatsService svc) =>
        {
            try
            {
                if (year is null or 0 || month is null || month < 1 || month > 12)
                    return Results.Json(new { error = "Нужны year и month (1–12)" }, statusCode: 400);
                var idMap = await svc.GetIdMapAsync();
                var result = await svc.GetMonthlyCompanyAsync(year.Value, month.Value, shift, idMap);
                return Results.Json(result);
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        app.MapGet("/api/stats/monthly-employees", async (string? dateFrom, string? dateTo, string? shift, string? zone, StatsService svc) =>
        {
            try
            {
                var from = (dateFrom ?? "").Length >= 10 ? dateFrom![..10] : (dateFrom ?? "");
                var to = (dateTo ?? "").Length >= 10 ? dateTo![..10] : (dateTo ?? "");
                if (from == "" || to == "") return Results.Json(new { error = "Нужны dateFrom и dateTo (YYYY-MM-DD)" }, statusCode: 400);
                var normalizedShift = shift == "day" || shift == "night" ? shift : null;
                var zoneFilter = (zone ?? "").ToUpperInvariant();
                var idMap = await svc.GetIdMapAsync();
                var result = await svc.GetMonthlyEmployeesAsync(from, to, normalizedShift, zoneFilter, idMap);
                return Results.Json(result);
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();

        // ─── Веса товаров (только чтение — загрузка/удаление Excel осталась на Node) ─

        app.MapGet("/api/product-weights", async (StatsService svc) =>
        {
            try
            {
                var map = await svc.GetWeightMapAsync();
                return Results.Json(map);
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });
    }

    private static string NormalizeFioForMatch(string? fio)
    {
        var s = (fio ?? "").Trim();
        s = System.Text.RegularExpressions.Regex.Replace(s, @"^-\s+", "");
        s = s.Trim();
        s = System.Text.RegularExpressions.Regex.Replace(s, @"\s+", " ");
        return s.ToLowerInvariant();
    }

    // Плоское слияние двух object-подобных значений в один Dictionary для
    // JSON-ответа (аналог res.json({ date, shift, ...summary }) в оригинале).
    private static Dictionary<string, object?> Merge(object head, object tail)
    {
        var result = new Dictionary<string, object?>();
        foreach (var p in head.GetType().GetProperties()) result[ToCamelCase(p.Name)] = p.GetValue(head);
        foreach (var p in tail.GetType().GetProperties()) result[ToCamelCase(p.Name)] = p.GetValue(tail);
        return result;
    }

    private static string ToCamelCase(string s) => s.Length == 0 ? s : char.ToLowerInvariant(s[0]) + s[1..];
}
