using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using ClosedXML.Excel;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using BackendDotnet.Data;

namespace BackendDotnet.Endpoints;

// «Консолидация» — жалобы на нарушения (перенесено из Node 2026-10-31).
// Строка на жалобу: поля — в data (jsonb, тот же объект, что получает
// страница). Фото приходят уже сжатыми браузером (JPEG + миниатюра _t.jpg),
// сервер только сохраняет их в uploads тома node-persist — раздаёт Caddy.
// Время в Excel-отчётах — московское (Node писал UTC).
public static class ConsolidationEndpoints
{
    private static readonly string UploadsDir = Environment.GetEnvironmentVariable("CONSOLIDATION_PHOTOS_DIR") ?? "/data/node-persist/uploads";
    private static readonly TimeSpan Msk = TimeSpan.FromHours(3);
    private static readonly StringComparer Ru = StringComparer.Create(new CultureInfo("ru-RU"), false);
    private const long MaxPhotoBytes = 2 * 1024 * 1024;

    public static async Task EnsureSchemaAsync(NpgsqlConnection conn)
    {
        async Task Exec(string sql) { await using var cmd = new NpgsqlCommand(sql, conn); await cmd.ExecuteNonQueryAsync(); }
        await Exec(@"CREATE TABLE IF NOT EXISTS consolidation_complaints (
            warehouse_id TEXT NOT NULL, id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data JSONB NOT NULL,
            PRIMARY KEY (warehouse_id, id))");
        await Exec("CREATE INDEX IF NOT EXISTS consolidation_complaints_created_idx ON consolidation_complaints (warehouse_id, created_at DESC)");
    }

    // ─── хранение ─────────────────────────────────────────────────────────────

    private static async Task<List<JsonObject>> ListAsync(AppDbContext db, DateTimeOffset? from = null, DateTimeOffset? to = null)
    {
        var rows = await db.Database.SqlQueryRaw<string>(@"
            SELECT data::text AS ""Value"" FROM consolidation_complaints
             WHERE warehouse_id = @wh AND (@from::timestamptz IS NULL OR created_at >= @from) AND (@to::timestamptz IS NULL OR created_at <= @to)
             ORDER BY created_at DESC",
            new NpgsqlParameter("wh", db.WarehouseId),
            new NpgsqlParameter("from", NpgsqlTypes.NpgsqlDbType.TimestampTz) { Value = (object?)from?.UtcDateTime ?? DBNull.Value },
            new NpgsqlParameter("to", NpgsqlTypes.NpgsqlDbType.TimestampTz) { Value = (object?)to?.UtcDateTime ?? DBNull.Value }).ToListAsync();
        return rows.Select(r => JsonNode.Parse(r)!.AsObject()).ToList();
    }

    private static async Task<JsonObject?> GetAsync(AppDbContext db, string id) =>
        (await db.Database.SqlQueryRaw<string>("SELECT data::text AS \"Value\" FROM consolidation_complaints WHERE warehouse_id = @wh AND id = @id",
            new NpgsqlParameter("wh", db.WarehouseId), new NpgsqlParameter("id", id)).ToListAsync())
        .Select(r => JsonNode.Parse(r)!.AsObject()).FirstOrDefault();

    private static async Task<JsonObject?> PatchAsync(AppDbContext db, string id, JsonObject fields) =>
        (await db.Database.SqlQueryRaw<string>(
            "UPDATE consolidation_complaints SET data = data || @f::jsonb WHERE warehouse_id = @wh AND id = @id RETURNING data::text AS \"Value\"",
            new NpgsqlParameter("wh", db.WarehouseId), new NpgsqlParameter("id", id), new NpgsqlParameter("f", fields.ToJsonString())).ToListAsync())
        .Select(r => JsonNode.Parse(r)!.AsObject()).FirstOrDefault();

    // ─── компания нарушителя ──────────────────────────────────────────────────

    private static string NormFio(string? fio) =>
        System.Text.RegularExpressions.Regex.Replace(System.Text.RegularExpressions.Regex.Replace((fio ?? "").Trim(), @"^-\s+", "").Trim(), @"\s+", " ").ToLowerInvariant();

    private class EmplRow { public string ExecutorId { get; set; } = ""; public string Fio { get; set; } = ""; public string Company { get; set; } = ""; }

    private static async Task<(List<KeyValuePair<string, string>> FioMap, Dictionary<string, string> IdMap)> LookupMapsAsync(AppDbContext db)
    {
        var rows = await db.Database.SqlQueryRaw<EmplRow>(
            "SELECT executor_id AS \"ExecutorId\", fio AS \"Fio\", COALESCE(company, '') AS \"Company\" FROM employees WHERE warehouse_id = @wh",
            new NpgsqlParameter("wh", db.WarehouseId)).ToListAsync();
        var fio = new List<KeyValuePair<string, string>>(); var seen = new HashSet<string>();
        var ids = new Dictionary<string, string>();
        foreach (var r in rows)
        {
            var key = NormFio(r.Fio);
            if (key != "" && seen.Add(key)) fio.Add(new(key, r.Company));
            if (r.ExecutorId != "") ids[r.ExecutorId] = r.Company;
        }
        return (fio, ids);
    }

    // точное совпадение или подстрока — для старых жалоб без компании
    private static string? CompanyByFio(List<KeyValuePair<string, string>> fioMap, string? fio)
    {
        var norm = NormFio(fio);
        if (norm == "") return null;
        foreach (var (key, company) in fioMap)
            if (norm == key || norm.Contains(key) || key.Contains(norm)) return company;
        return null;
    }

    private static string Str(JsonObject c, string k) => c[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : (c[k]?.ToString() ?? "");
    private static bool HasCompany(JsonObject c) => Str(c, "company").Trim() != "";
    private static JsonObject WithCompany(JsonObject c, List<KeyValuePair<string, string>> fioMap)
    {
        if (!HasCompany(c)) c["company"] = CompanyByFio(fioMap, Str(c, "violator")) ?? "";
        return c;
    }
    private static List<string> Photos(JsonObject c) =>
        c["photoFilenames"] is JsonArray a && a.Count > 0 ? a.Select(x => x?.ToString() ?? "").Where(x => x != "").ToList()
        : Str(c, "photoFilename") is var p && p != "" ? new() { p } : new();
    private static string ThumbName(string name) => name.EndsWith(".jpg") ? name[..^4] + "_t.jpg" : name;
    private static bool IsJpeg(byte[] b) => b.Length > 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff;
    private static DateTimeOffset? Iso(string s) => DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null;

    public static void MapConsolidationEndpoints(this WebApplication app)
    {
        Directory.CreateDirectory(UploadsDir);
        var g = app.MapGroup("/api/consolidation").AddEndpointFilter<VsSessionRequiredFilter>();

        // подать жалобу (форма-киоск, фото multipart: photo[], thumb[])
        g.MapPost("/complaints", async (HttpContext ctx, AppDbContext db) =>
        {
            try
            {
                if (!ctx.Request.HasFormContentType) return Results.Json(new { ok = false, error = "Ожидается multipart/form-data" }, statusCode: 400);
                var form = await ctx.Request.ReadFormAsync();
                string F(string k) => form[k].ToString();
                var cell = F("cell").Trim(); var barcode = F("barcode").Trim(); var hu = F("handlingUnitBarcode").Trim();
                var isZgh = cell.ToUpperInvariant() == "ZGH";
                if (isZgh && hu == "") return Results.Json(new { ok = false, error = "Укажите штрихкод ЕО" }, statusCode: 400);
                if (!isZgh && (cell == "" || barcode == "")) return Results.Json(new { ok = false, error = "Укажите место хранения и штрихкод" }, statusCode: 400);

                var id = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}"[..20];
                var photos = form.Files.GetFiles("photo").Take(10).ToList();
                var thumbs = form.Files.GetFiles("thumb").Take(10).ToList();
                var names = new JsonArray();
                for (var i = 0; i < photos.Count; i++)
                {
                    if (photos[i].Length > MaxPhotoBytes) continue;
                    using var ms = new MemoryStream(); await photos[i].CopyToAsync(ms);
                    var buf = ms.ToArray();
                    if (!IsJpeg(buf)) continue;
                    var name = $"{id}{(i == 0 ? "" : $"_{i + 1}")}.jpg";
                    await File.WriteAllBytesAsync(Path.Combine(UploadsDir, name), buf);
                    if (i < thumbs.Count && thumbs[i].Length <= MaxPhotoBytes)
                    {
                        using var tm = new MemoryStream(); await thumbs[i].CopyToAsync(tm);
                        if (IsJpeg(tm.ToArray())) await File.WriteAllBytesAsync(Path.Combine(UploadsDir, ThumbName(name)), tm.ToArray());
                    }
                    names.Add(name);
                }
                var now = DateTime.UtcNow;
                var c = new JsonObject
                {
                    ["id"] = id, ["createdAt"] = now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), ["cell"] = cell, ["barcode"] = barcode,
                    ["employeeName"] = F("employeeName").Trim() is var en && en != "" ? en : null,
                    ["photoFilename"] = names.Count > 0 ? names[0]!.ToString() : null, ["photoFilenames"] = names,
                    ["handlingUnitBarcode"] = hu != "" ? hu : null,
                    ["productName"] = null, ["nomenclatureCode"] = null, ["productBarcode"] = null, ["violator"] = null, ["violatorId"] = null,
                    ["operationType"] = null, ["operationCompletedAt"] = null, ["status"] = "new", ["lookupDone"] = false, ["lookupError"] = null,
                };
                await db.Database.ExecuteSqlRawAsync(
                    "INSERT INTO consolidation_complaints (warehouse_id, id, created_at, data) VALUES (@wh, @id, @at, @d::jsonb)",
                    new NpgsqlParameter("wh", db.WarehouseId), new NpgsqlParameter("id", id), new NpgsqlParameter("at", now), new NpgsqlParameter("d", c.ToJsonString()));
                return Results.Json(new { ok = true, id });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        // список; from/to — ISO-границы даты подачи
        g.MapGet("/complaints", async (string? from, string? to, AppDbContext db) =>
        {
            try
            {
                var list = await ListAsync(db, from != null ? Iso(from) : null, to != null ? Iso(to) : null);
                var (fioMap, _) = await LookupMapsAsync(db);
                return Results.Json(list.Select(c => WithCompany(c, fioMap)));
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        g.MapDelete("/complaints/{id}", async (string id, AppDbContext db) =>
        {
            try
            {
                var removed = (await db.Database.SqlQueryRaw<string>(
                    "DELETE FROM consolidation_complaints WHERE warehouse_id = @wh AND id = @id RETURNING data::text AS \"Value\"",
                    new NpgsqlParameter("wh", db.WarehouseId), new NpgsqlParameter("id", id)).ToListAsync()).FirstOrDefault();
                if (removed == null) return Results.Json(new { ok = false, error = "Не найдено" }, statusCode: 404);
                foreach (var f in Photos(JsonNode.Parse(removed)!.AsObject()))
                    foreach (var n in new[] { f, ThumbName(f) })
                    {
                        var p = Path.Combine(UploadsDir, Path.GetFileName(n));
                        try { if (File.Exists(p)) File.Delete(p); } catch { /* не критично */ }
                    }
                return Results.Json(new { ok = true });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        // результат WMS-поиска нарушителя (ищет браузер, сюда — сохранить)
        g.MapPut("/complaints/{id}/lookup", async (string id, JsonElement body, AppDbContext db) =>
        {
            try
            {
                var item = await GetAsync(db, id);
                if (item == null) return Results.Json(new { ok = false, error = "Не найдено" }, statusCode: 404);
                var d = body.ValueKind == JsonValueKind.Object ? JsonNode.Parse(body.GetRawText())!.AsObject() : new JsonObject();
                foreach (var k in new[] { "cell", "barcode", "productName", "nomenclatureCode", "productBarcode", "violator", "violatorId",
                                          "handlingUnitBarcode", "operationType", "operationCompletedAt", "lookupDone", "lookupError", "company" })
                    if (d.ContainsKey(k)) item[k] = d[k]?.DeepClone();
                if (d.ContainsKey("taskArea"))
                    item["taskArea"] = Str(d, "taskArea") is "kdk" or "storage" ? Str(d, "taskArea") : "";
                else if (d["operationType"] != null && Str(item, "taskArea").Trim() == "")
                {
                    // зона по типу задачи: отбор в КДК или хранение
                    var op = Str(d, "operationType").ToUpperInvariant();
                    item["taskArea"] = op == "PICK_BY_LINE" || op.Contains("PALLET") ? "kdk" : "storage";
                }
                if (item["violator"] != null && !HasCompany(item))
                    item["company"] = CompanyByFio((await LookupMapsAsync(db)).FioMap, Str(item, "violator")) ?? "";
                var saved = await PatchAsync(db, id, item);
                return Results.Json(new { ok = true, complaint = saved });
            }
            catch (Exception err) { return Results.Json(new { ok = false, error = err.Message }, statusCode: 500); }
        });

        // ─── Excel-отчёты ──────────────────────────────────────────────────────

        g.MapPost("/export/report1", async (HttpContext ctx, JsonElement body, AppDbContext db) =>
        {
            try
            {
                var (dateFrom, dateTo, names, _) = ReportArgs(body);
                var list = await ReportListAsync(db, dateFrom, dateTo);
                var proto = ctx.Request.Headers["X-Forwarded-Proto"].FirstOrDefault() ?? ctx.Request.Scheme;
                var host = ctx.Request.Headers["X-Forwarded-Host"].FirstOrDefault() ?? ctx.Request.Host.Value;
                var bytes = Report1(list, names, $"{proto}://{host}/api/consolidation/uploads/");
                return Results.File(bytes, Xlsx, $"Нарушения_{dateFrom ?? "все"}_{dateTo ?? "все"}.xlsx");
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });

        g.MapPost("/export/report2", async (JsonElement body, AppDbContext db) =>
        {
            try
            {
                var (dateFrom, dateTo, names, fine) = ReportArgs(body);
                var list = await ReportListAsync(db, dateFrom, dateTo);

                // дни периода для листа «Анализ»
                var first = dateFrom ?? (list.Count > 0 ? list.Min(c => MskDate(Str(c, "createdAt"))) : null) ?? MskToday();
                var last = dateTo ?? MskToday();
                var range = new List<string>();
                for (var d = DateOnly.Parse(first, CultureInfo.InvariantCulture); d <= DateOnly.Parse(last, CultureInfo.InvariantCulture); d = d.AddDays(1))
                    range.Add(d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

                // выход по компаниям за день — уникальные комплектовщики (смена 09:00→09:00)
                var (_, idMap) = await LookupMapsAsync(db);
                var employees = new Dictionary<string, Dictionary<string, HashSet<string>>>();
                if (range.Count > 0)
                {
                    var pickers = await db.Database.SqlQueryRaw<PickerRow>(@"
                        SELECT d AS ""Date"", executor_id AS ""ExecutorId"", max(executor) AS ""Executor""
                          FROM (SELECT to_char(CASE WHEN hour >= 9 THEN date ELSE date - 1 END, 'YYYY-MM-DD') AS d, executor_id, executor
                                  FROM wms_ops
                                 WHERE warehouse_id = @wh
                                   AND operation_type IN ('PICK_BY_LINE', 'PALLET_SELECTION_MOVE_TO_PICK_BY_LINE', 'PIECE_SELECTION_PICKING')
                                   AND date BETWEEN @f::date AND @t::date + 1 AND (executor_id <> '' OR executor <> '')) AS t
                         WHERE d BETWEEN @f AND @t GROUP BY d, executor_id",
                        new NpgsqlParameter("wh", db.WarehouseId), new NpgsqlParameter("f", range[0]), new NpgsqlParameter("t", range[^1])).ToListAsync();
                    foreach (var p in pickers)
                    {
                        var comp = p.ExecutorId != "" && idMap.TryGetValue(p.ExecutorId, out var c) && c != null ? c : "—";
                        if (!employees.TryGetValue(p.Date, out var byComp)) employees[p.Date] = byComp = new();
                        if (!byComp.TryGetValue(comp, out var set)) byComp[comp] = set = new();
                        set.Add(p.ExecutorId != "" ? p.ExecutorId : NormFio(p.Executor));
                    }
                }
                var bytes = Report2(list, names, fine, employees, range);
                return Results.File(bytes, Xlsx, $"Сводка_нарушений_{dateFrom ?? "все"}_{dateTo ?? "все"}.xlsx");
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        });
    }

    private const string Xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    private class PickerRow { public string Date { get; set; } = ""; public string ExecutorId { get; set; } = ""; public string Executor { get; set; } = ""; }

    private static (string? From, string? To, Dictionary<string, string> Names, decimal Fine) ReportArgs(JsonElement b)
    {
        string? S(string k) => b.ValueKind == JsonValueKind.Object && b.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: >= 10 } s ? s[..10] : null;
        var names = new Dictionary<string, string>();
        if (b.ValueKind == JsonValueKind.Object && b.TryGetProperty("companyFullNames", out var n) && n.ValueKind == JsonValueKind.Object)
            foreach (var p in n.EnumerateObject()) names[p.Name] = p.Value.ToString();
        decimal fine = 0;
        if (b.ValueKind == JsonValueKind.Object && b.TryGetProperty("fineAmount", out var f))
            decimal.TryParse(f.ToString(), NumberStyles.Any, CultureInfo.InvariantCulture, out fine);
        return (S("dateFrom"), S("dateTo"), names, fine);
    }

    private static string? MskDate(string iso) => Iso(iso) is { } d ? d.ToOffset(Msk).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
    private static string MskToday() => DateTimeOffset.UtcNow.ToOffset(Msk).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    // жалобы за дни dateFrom..dateTo (по Москве) с компанией нарушителя
    private static async Task<List<JsonObject>> ReportListAsync(AppDbContext db, string? dateFrom, string? dateTo)
    {
        DateTimeOffset? Day(string? d, int add) => d != null && DateOnly.TryParse(d, CultureInfo.InvariantCulture, out var x)
            ? new DateTimeOffset(x.AddDays(add).ToDateTime(TimeOnly.MinValue), Msk) : null;
        var list = await ListAsync(db, Day(dateFrom, 0), Day(dateTo, 1)?.AddTicks(-1));
        var (fioMap, _) = await LookupMapsAsync(db);
        return list.Select(c => WithCompany(c, fioMap)).ToList();
    }

    // ─── оформление (как было в consolidation-reports.js) ─────────────────────

    private static readonly XLColor Header = XLColor.FromHtml("#B8CCE4"), Totals = XLColor.FromHtml("#D9E1F2"),
        Row0 = XLColor.White, Row1 = XLColor.FromHtml("#F2F7FC"), Border = XLColor.FromHtml("#9DC3E6"), Link = XLColor.FromHtml("#0563C1");

    private static string SheetName(string s) => System.Text.RegularExpressions.Regex.Replace(s == "" ? "Лист" : s, @"[\\/\?\*\[\]:]", "_") is var n && n.Length > 31 ? n[..31] : n;
    private static string Official(string raw, Dictionary<string, string> names) =>
        raw.Trim() == "" ? "Без компании" : names.TryGetValue(raw, out var full) && full.Trim() != "" ? full.Trim() : raw.Trim();

    private static void Box(IXLRange r, XLColor fill, bool bold)
    {
        r.Style.Font.FontName = "Calibri"; r.Style.Font.FontSize = 10; r.Style.Font.Bold = bold;
        r.Style.Fill.BackgroundColor = fill;
        r.Style.Border.OutsideBorder = XLBorderStyleValues.Thin; r.Style.Border.InsideBorder = XLBorderStyleValues.Thin;
        r.Style.Border.OutsideBorderColor = Border; r.Style.Border.InsideBorderColor = Border;
        r.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
    }

    // шапка + чередование строк; numericCols — по центру (числа под заголовком)
    private static void Table(IXLWorksheet ws, (string Title, double Width)[] cols, int dataRows, int[] numericCols, bool totalsRow = false)
    {
        for (var i = 0; i < cols.Length; i++) { ws.Cell(1, i + 1).Value = cols[i].Title; ws.Column(i + 1).Width = cols[i].Width; }
        var head = ws.Range(1, 1, 1, cols.Length);
        Box(head, Header, true);
        head.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center; head.Style.Alignment.WrapText = true;
        ws.Row(1).Height = 26;
        for (var r = 2; r < 2 + dataRows; r++)
        {
            var row = ws.Range(r, 1, r, cols.Length);
            Box(row, r % 2 == 0 ? Row1 : Row0, false);
            row.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Left;
        }
        if (totalsRow)
        {
            var tr = 2 + dataRows;
            Box(ws.Range(tr, 1, tr, cols.Length), Totals, true);
            ws.Row(tr).Height = 20;
        }
        var lastRow = 1 + dataRows + (totalsRow ? 1 : 0);
        foreach (var c in numericCols) ws.Range(2, c, Math.Max(2, lastRow), c).Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
        ws.SheetView.FreezeRows(1);
    }

    private static byte[] Save(XLWorkbook wb) { using var ms = new MemoryStream(); wb.SaveAs(ms); return ms.ToArray(); }

    // Отчёт 1 — детальный: лист на компанию, строки — нарушения с найденным нарушителем
    private static byte[] Report1(List<JsonObject> list, Dictionary<string, string> names, string photoBase)
    {
        using var wb = new XLWorkbook();
        var byCompany = list.Where(c => Str(c, "violator") != "").GroupBy(c => Official(Str(c, "company"), names)).OrderBy(x => x.Key, Ru).ToList();
        if (byCompany.Count == 0)
        {
            wb.Worksheets.Add("Нет данных").Cell(1, 1).Value = "Нарушения с установленным нарушителем за выбранный период не найдены";
            return Save(wb);
        }
        foreach (var grp in byCompany)
        {
            var ws = wb.Worksheets.Add(SheetName(grp.Key));
            var items = grp.OrderBy(c => Str(c, "createdAt"), StringComparer.Ordinal).ToList();
            Table(ws, new[] { ("Дата", 12.0), ("Время", 10.0), ("Ячейка", 16.0), ("ФИО нарушителя", 28.0), ("Товар", 34.0), ("Артикул", 18.0), ("Штрихкод", 18.0), ("Ссылка на фото", 48.0) },
                items.Count, new[] { 1, 2 });
            for (var i = 0; i < items.Count; i++)
            {
                var c = items[i]; var r = i + 2;
                if (Iso(Str(c, "createdAt")) is { } at)
                {
                    var local = at.ToOffset(Msk).DateTime;
                    ws.Cell(r, 1).Value = local.Date; ws.Cell(r, 1).Style.DateFormat.Format = "dd.mm.yyyy";
                    ws.Cell(r, 2).Value = local.ToString("HH:mm", CultureInfo.InvariantCulture);
                }
                ws.Cell(r, 3).Value = Str(c, "cell"); ws.Cell(r, 4).Value = Str(c, "violator"); ws.Cell(r, 5).Value = Str(c, "productName");
                ws.Cell(r, 6).Value = Str(c, "nomenclatureCode"); ws.Cell(r, 7).Value = Str(c, "barcode");
                var photos = Photos(c);
                if (photos.Count > 0)
                {
                    var link = ws.Cell(r, 8);
                    link.Value = "Открыть фото";
                    link.SetHyperlink(new XLHyperlink(photoBase + Uri.EscapeDataString(photos[0])));
                    link.Style.Font.FontColor = Link; link.Style.Font.Underline = XLFontUnderlineValues.Single;
                }
            }
        }
        return Save(wb);
    }

    // Отчёт 2 — сводный: по компаниям ФИО / ошибки / штраф + лист «Анализ»
    private static byte[] Report2(List<JsonObject> list, Dictionary<string, string> names, decimal fine,
        Dictionary<string, Dictionary<string, HashSet<string>>> employeesByDay, List<string> range)
    {
        using var wb = new XLWorkbook();
        var found = list.Where(c => Str(c, "violator") != "").ToList();
        var byCompany = found.GroupBy(c => Official(Str(c, "company"), names)).OrderBy(x => x.Key, Ru).ToList();
        foreach (var grp in byCompany)
        {
            var ws = wb.Worksheets.Add(SheetName(grp.Key));
            // порядок первых появлений, затем по убыванию ошибок (как в Node)
            var counts = new List<(string Fio, int Count)>();
            foreach (var c in grp)
            {
                var v = Str(c, "violator"); var idx = counts.FindIndex(x => x.Fio == v);
                if (idx < 0) counts.Add((v, 1)); else counts[idx] = (v, counts[idx].Count + 1);
            }
            var sorted = counts.OrderByDescending(x => x.Count).ToList();
            Table(ws, new[] { ("ФИО нарушителя", 32.0), ("Количество ошибок", 20.0), ("Сумма штрафа, руб.", 22.0) }, sorted.Count, new[] { 2, 3 }, totalsRow: true);
            for (var i = 0; i < sorted.Count; i++)
            {
                ws.Cell(i + 2, 1).Value = sorted[i].Fio; ws.Cell(i + 2, 2).Value = sorted[i].Count; ws.Cell(i + 2, 3).Value = sorted[i].Count * fine;
            }
            var total = sorted.Sum(x => x.Count); var tr = sorted.Count + 2;
            ws.Cell(tr, 1).Value = "ИТОГО"; ws.Cell(tr, 2).Value = total; ws.Cell(tr, 3).Value = total * fine;
        }

        // «Анализ»: день × компания — сотрудников, ошибок, % нарушающих, штраф
        var vMap = new Dictionary<string, int>(); var uMap = new Dictionary<string, HashSet<string>>();
        foreach (var c in found)
        {
            var key = $"{MskDate(Str(c, "createdAt"))}|{Official(Str(c, "company"), names)}";
            vMap[key] = vMap.GetValueOrDefault(key) + 1;
            if (!uMap.TryGetValue(key, out var s)) uMap[key] = s = new();
            s.Add(Str(c, "violator"));
        }
        var companies = new HashSet<string>(byCompany.Select(x => x.Key));
        foreach (var day in employeesByDay.Values) foreach (var raw in day.Keys) companies.Add(Official(raw, names));
        var allCompanies = companies.OrderBy(x => x, Ru).ToList();

        var rows = new List<(DateTime Date, string Company, int Employees, int Violations, string Percent, decimal Fine)>();
        foreach (var date in range)
        {
            var empByOfficial = new Dictionary<string, int>();
            if (employeesByDay.TryGetValue(date, out var day))
                foreach (var (raw, set) in day) { var o = Official(raw, names); empByOfficial[o] = empByOfficial.GetValueOrDefault(o) + set.Count; }
            foreach (var company in allCompanies)
            {
                var emp = empByOfficial.GetValueOrDefault(company);
                var viol = vMap.GetValueOrDefault($"{date}|{company}");
                if (emp == 0 && viol == 0) continue;
                var uniq = uMap.TryGetValue($"{date}|{company}", out var u) ? u.Count : 0;
                var pct = emp > 0 ? (uniq * 100.0 / emp).ToString("0.0", CultureInfo.InvariantCulture) + "%" : "—";
                rows.Add((DateTime.ParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture), company, emp, viol, pct, viol * fine));
            }
        }
        var a = wb.Worksheets.Add("Анализ");
        Table(a, new[] { ("Дата", 14.0), ("Компания", 34.0), ("Сотрудников", 16.0), ("Количество ошибок", 20.0), ("% нарушающих", 18.0), ("Сумма штрафа, руб.", 22.0) },
            rows.Count, new[] { 1, 3, 4, 5, 6 });
        for (var i = 0; i < rows.Count; i++)
        {
            var r = i + 2; var x = rows[i];
            a.Cell(r, 1).Value = x.Date; a.Cell(r, 1).Style.DateFormat.Format = "dd.mm.yyyy";
            a.Cell(r, 2).Value = x.Company; a.Cell(r, 3).Value = x.Employees; a.Cell(r, 4).Value = x.Violations;
            a.Cell(r, 5).Value = x.Percent; a.Cell(r, 6).Value = x.Fine;
        }
        return Save(wb);
    }
}
