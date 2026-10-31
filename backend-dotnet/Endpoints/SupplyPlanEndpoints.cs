using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using ExcelDataReader;
using Microsoft.AspNetCore.Http.Features;
using Npgsql;
using BackendDotnet.Data;

namespace BackendDotnet.Endpoints;

// График поставок (план приёмки по дням), перенесено из Node supply-plans-pg.js 2026-10-31.
//
// Источник — Excel из корпоративной почты («График поставок», несколько дат в
// одной таблице) или накопительный отчёт делопроизводителей (по листу на
// день; лист «статистика» — итоги факта по дням). Колонки ищутся по
// названию: в старых листах между ними бывают пустые/служебные столбцы.
// Загрузка заменяет строки тех дат, что есть в файле.
//
// supply_plans — заказ поставщику на дату; supply_plan_facts — сверка с WMS
// (ищет браузер) по заказам и вне графика (extra); supply_day_facts — итоги
// факта по дням из «статистики» (история до сверок на сайте). Из них —
// накопительный отчёт и рейтинг поставщиков; прогноз СЗ КДК — план кросс-дока
// против фактических СЗ КДК (wms_ops).
public static class SupplyPlanEndpoints
{
    private const long MaxFileBytes = 60L * 1024 * 1024; // накопительный отчёт за полтора года ~25 МБ
    private static readonly Regex DayRe = new(@"^\d{4}-\d{2}-\d{2}$");

    public record PlanRow(string Date, string OrderNumber, string Supplier, string DocType, string StorageType, string SupplyType, double Sku, double Pieces, double WeightKg);
    public record DayFact(string Date, double Count, double Pieces, double WeightKg, double Sku);

    // ─── разбор файла ─────────────────────────────────────────────────────────

    private static string CellStr(object? v) => v switch
    {
        null => "",
        double d when d % 1 == 0 && Math.Abs(d) < 1e17 => ((long)d).ToString(CultureInfo.InvariantCulture),
        double d => d.ToString(CultureInfo.InvariantCulture),
        DateTime dt => dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        _ => Convert.ToString(v, CultureInfo.InvariantCulture)?.Trim() ?? "",
    };

    // «1,408» / «1 786.02» / «7261.20» / «0,5» → число
    private static double ParseNum(object? v)
    {
        if (v is double d) return d;
        if (v is int i) return i;
        var s = Regex.Replace(CellStr(v), @"[\s  ]", "");
        if (s == "") return 0;
        s = s.Contains(',') && s.Contains('.') ? s.Replace(",", "") : s.Replace(',', '.');
        var m = Regex.Match(s, @"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?");
        return m.Success && double.TryParse(m.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n : 0;
    }

    // «28-10-2026» / «28.10.2026» / Excel-дата → «2026-10-28»
    private static string? ParseDate(object? v)
    {
        switch (v)
        {
            case null: return null;
            case DateTime dt: return dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            case double d: return new DateTime(1899, 12, 30).AddDays(Math.Round(d)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        var m = Regex.Match(CellStr(v), @"^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})");
        if (!m.Success) return null;
        var y = m.Groups[3].Value.Length == 2 ? "20" + m.Groups[3].Value : m.Groups[3].Value;
        return $"{y}-{m.Groups[2].Value.PadLeft(2, '0')}-{m.Groups[1].Value.PadLeft(2, '0')}";
    }

    // «Холод» (старые листы) — это средний холод
    private static string NormStorage(object? v) => CellStr(v) is var s && Regex.IsMatch(s, "^холод$", RegexOptions.IgnoreCase) ? "Средний холод" : s;

    // строки листа: не больше maxRows (часть листов «растянута» до миллиона
    // пустых строк — иначе разбор шёл минутами) и maxCols столбцов
    private static List<object?[]> ReadSheet(IExcelDataReader r, int maxRows, int maxCols)
    {
        var rows = new List<object?[]>();
        while (rows.Count < maxRows && r.Read())
        {
            var n = Math.Min(r.FieldCount, maxCols);
            var row = new object?[maxCols];
            for (var c = 0; c < n; c++) row[c] = r.GetValue(c);
            rows.Add(row);
        }
        return rows;
    }

    public static (List<PlanRow> Rows, List<DayFact> DayFacts) ParseWorkbook(Stream stream)
    {
        var horizon = DateTime.Today.AddDays(60).ToString("yyyy-MM-dd");
        bool Plausible(string? d) => d != null && string.CompareOrdinal(d, "2020-01-01") >= 0 && string.CompareOrdinal(d, horizon) <= 0;
        var outRows = new Dictionary<string, PlanRow>(); // дата|заказ → строка (повтор — берём последний)
        var dayFacts = new List<DayFact>();

        using var reader = ExcelReaderFactory.CreateReader(stream);
        do
        {
            var name = reader.Name ?? "";
            if (Regex.IsMatch(name, "статист", RegexOptions.IgnoreCase))
            {
                // ДН | Дата | поставок план, факт, % | штуки … | вес … | SKU … — берём факт
                dayFacts.Clear();
                foreach (var r in ReadSheet(reader, 5001, 15))
                {
                    var date = ParseDate(r[1]);
                    if (date == null || string.CompareOrdinal(date, "2020-01-01") < 0 || r[3] is not double count) continue;
                    dayFacts.Add(new(date, count, ParseNum(r[6]), ParseNum(r[9]), ParseNum(r[12])));
                }
                continue;
            }
            var rows = ReadSheet(reader, 5001, 41);
            // дата строки невозможная (опечатка в годе, мусор) — берём дату из
            // названия листа накопительного отчёта (лист = день, «28.10.2026»)
            var sheetDate = ParseDate(name);
            var hr = rows.Take(6).ToList().FindIndex(r => r.Any(c => CellStr(c) == "Номер заказа"));
            if (hr < 0) continue;
            var h = rows[hr].Select(CellStr).ToList();
            int Col(string n) => h.IndexOf(n);
            int cDate = Col("Дата"), cOrder = Col("Номер заказа"), cSupplier = Col("Поставщик"), cDoc = Col("Тип документооборота"),
                cStorage = Col("Тип товара (тип хранения)"), cSupply = Col("Тип поставки"), cSku = Col("Кол-во SKU"), cPieces = Col("Кол-во штук"), cWeight = Col("Вес, кг");
            if (cDate < 0 || cOrder < 0) continue;
            for (var i = hr + 1; i < rows.Count; i++)
            {
                var r = rows[i];
                var order = CellStr(r[cOrder]);
                var date = ParseDate(r[cDate]);
                if (!Plausible(date) && Plausible(sheetDate)) date = sheetDate;
                if (order == "" || !Plausible(date)) continue;
                outRows[$"{date}|{order}"] = new(date!, order,
                    cSupplier >= 0 ? CellStr(r[cSupplier]) : "", cDoc >= 0 ? CellStr(r[cDoc]) : "",
                    cStorage >= 0 ? NormStorage(r[cStorage]) : "", cSupply >= 0 ? CellStr(r[cSupply]) : "",
                    cSku >= 0 ? ParseNum(r[cSku]) : 0, cPieces >= 0 ? ParseNum(r[cPieces]) : 0, cWeight >= 0 ? ParseNum(r[cWeight]) : 0);
            }
        } while (reader.NextResult());
        return (outRows.Values.ToList(), dayFacts);
    }

    // ─── чтение строк в JSON ──────────────────────────────────────────────────

    private static async Task<List<Dictionary<string, object?>>> QueryAsync(NpgsqlConnection conn, string sql, params object[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        foreach (var a in args) cmd.Parameters.AddWithValue(a);
        await using var r = await cmd.ExecuteReaderAsync();
        var list = new List<Dictionary<string, object?>>();
        while (await r.ReadAsync())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < r.FieldCount; i++)
                row[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i) switch
                {
                    DateTime dt => dt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
                    var v => v,
                };
            list.Add(row);
        }
        return list;
    }

    private const string PlanCols = @"to_char(plan_date, 'YYYY-MM-DD') AS date, order_number AS ""orderNumber"", supplier, doc_type AS ""docType"",
        storage_type AS ""storageType"", supply_type AS ""supplyType"", sku::float AS sku, pieces::float AS pieces, weight_kg::float AS ""weightKg""";

    public static void MapSupplyPlanEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/supply-plans").AddEndpointFilter<VsSessionRequiredFilter>();
        string Conn(IConfiguration cfg) => cfg["ConnectionStrings:Postgres"]!;

        g.MapPost("/upload", async (HttpContext ctx, IConfiguration cfg) =>
        {
            try
            {
                var size = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
                if (size is { IsReadOnly: false }) size.MaxRequestBodySize = MaxFileBytes + 1024 * 1024;
                if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { error = "Файл не получен" });
                var form = await ctx.Request.ReadFormAsync(new FormOptions { MultipartBodyLengthLimit = MaxFileBytes + 1024 * 1024 });
                var file = form.Files.GetFile("file");
                if (file == null) return Results.BadRequest(new { error = "Файл не получен" });
                using var ms = new MemoryStream();
                await file.CopyToAsync(ms);
                ms.Position = 0;
                // разбор — в пуле потоков: накопительный отчёт (сотни листов) читается секунды
                var (rows, dayFacts) = await Task.Run(() => ParseWorkbook(ms));
                if (rows.Count == 0) return Results.BadRequest(new { error = "В файле не найден график: нужны колонки «Дата» и «Номер заказа»" });

                var wh = WarehouseContext.Current(ctx);
                var dates = rows.Select(r => r.Date).Distinct().OrderBy(d => d, StringComparer.Ordinal).ToArray();
                await using var conn = new NpgsqlConnection(Conn(cfg));
                await conn.OpenAsync();
                await using (var tx = await conn.BeginTransactionAsync())
                {
                    await using (var del = new NpgsqlCommand("DELETE FROM supply_plans WHERE warehouse_id = $1 AND plan_date = ANY($2::date[])", conn, tx))
                    {
                        del.Parameters.AddWithValue(wh); del.Parameters.AddWithValue(dates);
                        await del.ExecuteNonQueryAsync();
                    }
                    foreach (var ch in rows.Chunk(2000))
                    {
                        await using var ins = new NpgsqlCommand(@"
                            INSERT INTO supply_plans (warehouse_id, plan_date, order_number, supplier, doc_type, storage_type, supply_type, sku, pieces, weight_kg)
                            SELECT $1, * FROM unnest($2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[])
                            ON CONFLICT (warehouse_id, plan_date, order_number) DO NOTHING", conn, tx);
                        ins.Parameters.AddWithValue(wh);
                        ins.Parameters.AddWithValue(ch.Select(r => r.Date).ToArray());
                        ins.Parameters.AddWithValue(ch.Select(r => r.OrderNumber).ToArray());
                        ins.Parameters.AddWithValue(ch.Select(r => r.Supplier).ToArray());
                        ins.Parameters.AddWithValue(ch.Select(r => r.DocType).ToArray());
                        ins.Parameters.AddWithValue(ch.Select(r => r.StorageType).ToArray());
                        ins.Parameters.AddWithValue(ch.Select(r => r.SupplyType).ToArray());
                        ins.Parameters.AddWithValue(ch.Select(r => r.Sku).ToArray());
                        ins.Parameters.AddWithValue(ch.Select(r => r.Pieces).ToArray());
                        ins.Parameters.AddWithValue(ch.Select(r => r.WeightKg).ToArray());
                        await ins.ExecuteNonQueryAsync();
                    }
                    await tx.CommitAsync();
                }
                // накопительный отчёт: итоги факта по дням — заменяют прежние для этих дат
                if (dayFacts.Count > 0)
                {
                    await using var df = new NpgsqlCommand(@"
                        INSERT INTO supply_day_facts (warehouse_id, plan_date, fact_count, fact_pieces, fact_weight_kg, fact_sku)
                        SELECT $1, * FROM unnest($2::date[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])
                        ON CONFLICT (warehouse_id, plan_date) DO UPDATE SET fact_count = EXCLUDED.fact_count, fact_pieces = EXCLUDED.fact_pieces,
                          fact_weight_kg = EXCLUDED.fact_weight_kg, fact_sku = EXCLUDED.fact_sku", conn);
                    // одна дата дважды в «статистике» сломала бы ON CONFLICT — берём последнюю
                    var uniq = dayFacts.GroupBy(d => d.Date).Select(x => x.Last()).ToList();
                    df.Parameters.AddWithValue(wh);
                    df.Parameters.AddWithValue(uniq.Select(d => d.Date).ToArray());
                    df.Parameters.AddWithValue(uniq.Select(d => d.Count).ToArray());
                    df.Parameters.AddWithValue(uniq.Select(d => d.Pieces).ToArray());
                    df.Parameters.AddWithValue(uniq.Select(d => d.WeightKg).ToArray());
                    df.Parameters.AddWithValue(uniq.Select(d => d.Sku).ToArray());
                    await df.ExecuteNonQueryAsync();
                }
                return Results.Json(new { ok = true, rows = rows.Count, dates = dates.Length, from = dates[0], to = dates[^1], dayFacts = dayFacts.Count });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // результат сверки с WMS за дату (по заказам + вне графика) — заменяет прежний
        g.MapPost("/facts", async (HttpContext ctx, JsonElement body, IConfiguration cfg) =>
        {
            try
            {
                var date = body.TryGetProperty("date", out var d) ? d.ToString() : "";
                if (!DayRe.IsMatch(date)) return Results.BadRequest(new { error = "Нужна дата YYYY-MM-DD" });
                var rows = body.TryGetProperty("rows", out var rr) && rr.ValueKind == JsonValueKind.Array ? rr.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Object).ToList() : new();
                string S(JsonElement r, string k) => r.TryGetProperty(k, out var v) && v.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? v.ToString() : "";
                object N(JsonElement r, string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble()
                    : r.TryGetProperty(k, out v) && v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var p) ? p : DBNull.Value;

                var wh = WarehouseContext.Current(ctx);
                await using var conn = new NpgsqlConnection(Conn(cfg));
                await conn.OpenAsync();
                await using var tx = await conn.BeginTransactionAsync();
                await using (var del = new NpgsqlCommand("DELETE FROM supply_plan_facts WHERE warehouse_id = $1 AND plan_date = $2::date", conn, tx))
                {
                    del.Parameters.AddWithValue(wh); del.Parameters.AddWithValue(date);
                    await del.ExecuteNonQueryAsync();
                }
                foreach (var r in rows)
                {
                    await using var ins = new NpgsqlCommand(@"
                        INSERT INTO supply_plan_facts (warehouse_id, plan_date, order_number, extra, supplier, supply_type, status, wms_status,
                          fact_sku, fact_pieces, fact_weight_kg, completed_at, gate, storage_type)
                        VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12::timestamptz, $13, $14)
                        ON CONFLICT DO NOTHING", conn, tx);
                    ins.Parameters.AddWithValue(wh); ins.Parameters.AddWithValue(date);
                    ins.Parameters.AddWithValue(S(r, "orderNumber"));
                    ins.Parameters.AddWithValue(r.TryGetProperty("extra", out var ex) && ex.ValueKind == JsonValueKind.True);
                    ins.Parameters.AddWithValue(S(r, "supplier")); ins.Parameters.AddWithValue(S(r, "supplyType"));
                    ins.Parameters.AddWithValue(S(r, "status")); ins.Parameters.AddWithValue(S(r, "wmsStatus"));
                    ins.Parameters.AddWithValue(N(r, "factSku")); ins.Parameters.AddWithValue(N(r, "factPieces")); ins.Parameters.AddWithValue(N(r, "factWeightKg"));
                    ins.Parameters.AddWithValue(S(r, "completedAt") is var ca && ca != "" ? ca : DBNull.Value);
                    ins.Parameters.AddWithValue(S(r, "gate")); ins.Parameters.AddWithValue(S(r, "storageType"));
                    await ins.ExecuteNonQueryAsync();
                }
                await tx.CommitAsync();
                return Results.Json(new { ok = true, saved = rows.Count });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // план + факт за период — накопительный отчёт и рейтинг поставщиков
        g.MapGet("/range", async (string? from, string? to, HttpContext ctx, IConfiguration cfg) =>
        {
            if (from == null || to == null || !DayRe.IsMatch(from) || !DayRe.IsMatch(to)) return Results.BadRequest(new { error = "Нужны from и to (YYYY-MM-DD)" });
            if ((DateTime.Parse(to, CultureInfo.InvariantCulture) - DateTime.Parse(from, CultureInfo.InvariantCulture)).TotalDays > 400) return Results.BadRequest(new { error = "Период не больше 400 дней" });
            try
            {
                var wh = WarehouseContext.Current(ctx);
                await using var conn = new NpgsqlConnection(Conn(cfg));
                await conn.OpenAsync();
                var plans = await QueryAsync(conn, $"SELECT {PlanCols} FROM supply_plans WHERE warehouse_id = $1 AND plan_date BETWEEN $2::date AND $3::date ORDER BY plan_date, supplier", wh, from, to);
                var facts = await QueryAsync(conn, @"
                    SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, order_number AS ""orderNumber"", extra, supplier, supply_type AS ""supplyType"",
                           status, wms_status AS ""wmsStatus"", fact_sku::float AS ""factSku"", fact_pieces::float AS ""factPieces"", fact_weight_kg::float AS ""factWeightKg"",
                           completed_at AS ""completedAt"", gate, storage_type AS ""storageType"", checked_at AS ""checkedAt""
                      FROM supply_plan_facts WHERE warehouse_id = $1 AND plan_date BETWEEN $2::date AND $3::date", wh, from, to);
                var dayFacts = await QueryAsync(conn, @"
                    SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, fact_count::float AS count, fact_pieces::float AS pieces, fact_weight_kg::float AS ""weightKg"", fact_sku::float AS sku
                      FROM supply_day_facts WHERE warehouse_id = $1 AND plan_date BETWEEN $2::date AND $3::date", wh, from, to);
                return Results.Json(new { plans, facts, dayFacts });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // даты с графиком: последние 60 дней и всё будущее — для выбора даты
        g.MapGet("/dates", async (HttpContext ctx, IConfiguration cfg) =>
        {
            try
            {
                var wh = WarehouseContext.Current(ctx);
                await using var conn = new NpgsqlConnection(Conn(cfg));
                await conn.OpenAsync();
                var dates = await QueryAsync(conn, @"
                    SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, count(*)::int AS orders
                      FROM supply_plans WHERE warehouse_id = $1 AND plan_date >= current_date - 60 GROUP BY plan_date ORDER BY plan_date", wh);
                var total = (await QueryAsync(conn, @"SELECT count(DISTINCT plan_date)::int AS days, to_char(min(plan_date), 'YYYY-MM-DD') AS first FROM supply_plans WHERE warehouse_id = $1", wh))[0];
                return Results.Json(new { dates, totalDays = total["days"], firstDate = total["first"] });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        // история для прогноза СЗ КДК: план кросс-дока по дням и фактические СЗ КДК
        // (PICK_BY_LINE: сотрудник + ячейка + товар) по дате смены 09:00 → 09:00
        g.MapGet("/kdk-history", async (int? days, HttpContext ctx, IConfiguration cfg) =>
        {
            try
            {
                var n = Math.Min(400, Math.Max(14, days is > 0 ? days.Value : 120));
                var wh = WarehouseContext.Current(ctx);
                await using var conn = new NpgsqlConnection(Conn(cfg));
                await conn.OpenAsync();
                var plans = await QueryAsync(conn, @"
                    SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, count(*)::int AS deliveries, sum(sku)::float AS sku, sum(pieces)::float AS pieces
                      FROM supply_plans WHERE warehouse_id = $1 AND supply_type ILIKE 'кросс%' AND plan_date >= current_date - $2::int GROUP BY plan_date", wh, n);
                var picks = await QueryAsync(conn, @"
                    SELECT to_char(CASE WHEN hour >= 9 THEN date ELSE date - 1 END, 'YYYY-MM-DD') AS date,
                           count(DISTINCT (executor_id, cell, nomenclature_code))::int AS tasks
                      FROM wms_ops WHERE warehouse_id = $1 AND operation_type = 'PICK_BY_LINE' AND date >= current_date - $2::int - 1 GROUP BY 1", wh, n);
                return Results.Json(new { plans, picks });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        g.MapGet("", async (string? date, HttpContext ctx, IConfiguration cfg) =>
        {
            if (date == null || !DayRe.IsMatch(date)) return Results.BadRequest(new { error = "Нужна дата YYYY-MM-DD" });
            try
            {
                await using var conn = new NpgsqlConnection(Conn(cfg));
                await conn.OpenAsync();
                var rows = await QueryAsync(conn, $"SELECT {PlanCols} FROM supply_plans WHERE warehouse_id = $1 AND plan_date = $2::date ORDER BY supplier, order_number",
                    WarehouseContext.Current(ctx), date);
                return Results.Json(new { date, rows });
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });
    }
}
