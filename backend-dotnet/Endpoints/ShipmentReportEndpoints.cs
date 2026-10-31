using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using BackendDotnet.Data;

namespace BackendDotnet.Endpoints;

// «Отчёт по РК, ящикам и ТЧ» (Отгрузка → Отчёт), перенесено из Node
// excel-reports.js 2026-10-31. По каждому адресу ЦФЗ и дню: отгружено /
// возвращено и долг за период; три листа — РК, ящики, термочехлы.
// Код получателя (SAP) — таблица address_codes (раньше address-codes.json),
// общая для складов.
public static class ShipmentReportEndpoints
{
    private static readonly string[] MonthNames = { "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь" };
    private static readonly StringComparer Ru = StringComparer.Create(new CultureInfo("ru-RU"), false);

    private class Cell
    {
        public double Shipped, ShippedBoxes, ShippedThermalCovers;
        public double? Received, ReceivedBoxes, ReceivedThermalCovers;
    }

    public static async Task EnsureSchemaAsync(NpgsqlConnection conn)
    {
        await using (var cmd = new NpgsqlCommand("CREATE TABLE IF NOT EXISTS address_codes (address TEXT PRIMARY KEY, sap_code TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())", conn))
            await cmd.ExecuteNonQueryAsync();
        // разовый перенос address-codes.json
        var legacy = Path.Combine(Services.ProductWeightsService.DataDir, "address-codes.json");
        if (!File.Exists(legacy)) return;
        await using (var cnt = new NpgsqlCommand("SELECT count(*) FROM address_codes", conn))
            if ((long)(await cnt.ExecuteScalarAsync())! > 0) return;
        try
        {
            using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(legacy));
            foreach (var p in doc.RootElement.EnumerateObject())
            {
                var code = p.Value.TryGetProperty("sapCode", out var c) ? c.ToString().Trim() : "";
                if (code == "") continue;
                await using var cmd = new NpgsqlCommand("INSERT INTO address_codes (address, sap_code, updated_at) VALUES ($1, $2, COALESCE($3::timestamptz, now())) ON CONFLICT DO NOTHING", conn);
                cmd.Parameters.AddWithValue(p.Name);
                cmd.Parameters.AddWithValue(code);
                cmd.Parameters.AddWithValue(p.Value.TryGetProperty("updatedAt", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString()! : DBNull.Value);
                await cmd.ExecuteNonQueryAsync();
            }
            Console.WriteLine("[shipments] коды получателей перенесены из address-codes.json");
        }
        catch (Exception err) { Console.WriteLine($"[shipments] address-codes.json: {err.Message}"); }
    }

    public static void MapShipmentReportEndpoints(this WebApplication app)
    {
        app.MapGet("/api/shipments/report", async (string? dateFrom, string? dateTo, AppDbContext db) =>
        {
            if (string.IsNullOrEmpty(dateFrom) || string.IsNullOrEmpty(dateTo)) return Results.BadRequest(new { error = "Нужны dateFrom и dateTo" });
            try
            {
                var routes = await db.Routes.AsNoTracking().ToListAsync();
                var codes = (await db.Database.SqlQueryRaw<CodeRow>("SELECT address AS \"Address\", sap_code AS \"SapCode\" FROM address_codes").ToListAsync())
                    .ToDictionary(c => c.Address, c => c.SapCode);

                // адрес → дата → суммы за день
                var data = new Dictionary<string, SortedDictionary<string, Cell>>();
                Cell At(string addr, string date)
                {
                    if (!data.TryGetValue(addr, out var dm)) data[addr] = dm = new(StringComparer.Ordinal);
                    if (!dm.TryGetValue(date, out var c)) dm[date] = c = new Cell();
                    return c;
                }
                string Day(string? at, DateOnly? date) => (at ?? date?.ToString("yyyy-MM-dd") ?? "") is var s && s.Length >= 10 ? s[..10] : s;
                bool InRange(string d) => string.CompareOrdinal(d, dateFrom) >= 0 && string.CompareOrdinal(d, dateTo) <= 0;

                var known = new HashSet<string>();
                foreach (var r in routes)
                {
                    foreach (var a in r.CfzAddresses) if (!string.IsNullOrEmpty(a.Address)) known.Add(a.Address);
                    if (r.Shipment != null && Day(r.Shipment.At, r.Date) is var sd && InRange(sd))
                        foreach (var it in r.Shipment.Items)
                        {
                            var c = At(it.Address, sd);
                            c.Shipped += it.Rk; c.ShippedBoxes += it.Boxes; c.ShippedThermalCovers += it.ThermalCovers;
                        }
                    if (r.Receiving != null && Day(r.Receiving.At, r.Date) is var rd && InRange(rd))
                        foreach (var it in r.Receiving.Items)
                        {
                            var c = At(it.Address, rd);
                            c.Received = (c.Received ?? 0) + it.Rk;
                            if (it.Boxes != 0) c.ReceivedBoxes = (c.ReceivedBoxes ?? 0) + it.Boxes;
                            if (it.ThermalCovers != 0) c.ReceivedThermalCovers = (c.ReceivedThermalCovers ?? 0) + it.ThermalCovers;
                        }
                }
                // пустые дни (ничего не отгружено и не принято) не показываем
                foreach (var dm in data.Values)
                    foreach (var d in dm.Where(kv => kv.Value is { Shipped: 0, Received: null, ShippedBoxes: 0, ReceivedBoxes: null, ShippedThermalCovers: 0, ReceivedThermalCovers: null }).Select(kv => kv.Key).ToList())
                        dm.Remove(d);
                var dates = data.Values.SelectMany(dm => dm.Keys).Distinct().OrderBy(d => d, StringComparer.Ordinal).ToList();

                // адреса: из маршрутов, из данных и из кодов; сначала с кодом (по
                // числу), потом без кода (по алфавиту)
                static int CodeNum(string? c) => c != null && Regex.Match(c, @"^\s*[-+]?\d+") is { Success: true } m && int.TryParse(m.Value, out var n) ? n : 0;
                var addresses = known.OrderBy(a => a, Ru)
                    .Concat(data.Where(kv => kv.Value.Count > 0).Select(kv => kv.Key).OrderBy(a => a, Ru))
                    .Concat(codes.Keys).Distinct()
                    .OrderBy(a => codes.ContainsKey(a) ? 0 : 1)
                    .ThenBy(a => codes.TryGetValue(a, out var c) ? CodeNum(c) : 0)
                    .ThenBy(a => codes.ContainsKey(a) ? "" : a, Ru)
                    .ToList();

                var monthSrc = dateFrom.Length >= 7 ? dateFrom : dates.FirstOrDefault() ?? "";
                var month = monthSrc.Length >= 7 && int.TryParse(monthSrc[5..7], out var mm) && mm is >= 1 and <= 12 ? $"{MonthNames[mm - 1]} {monthSrc[..4]}" : monthSrc;

                using var wb = new XLWorkbook();
                AddSheet(wb, month, data, dates, addresses, codes, c => c.Shipped, c => c.Received);
                AddSheet(wb, $"Ящики {month}", data, dates, addresses, codes, c => c.ShippedBoxes, c => c.ReceivedBoxes);
                AddSheet(wb, $"ТЧ {month}", data, dates, addresses, codes, c => c.ShippedThermalCovers, c => c.ReceivedThermalCovers);
                using var ms = new MemoryStream();
                wb.SaveAs(ms);
                return Results.File(ms.ToArray(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Отчет по РК, ящикам и ТЧ.xlsx");
            }
            catch (Exception err) { return Results.Json(new { error = err.Message }, statusCode: 500); }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }

    private class CodeRow { public string Address { get; set; } = ""; public string SapCode { get; set; } = ""; }

    private static void AddSheet(XLWorkbook wb, string name, Dictionary<string, SortedDictionary<string, Cell>> data, List<string> dates,
        List<string> addresses, Dictionary<string, string> codes, Func<Cell, double> shippedOf, Func<Cell, double?> receivedOf)
    {
        var header = XLColor.FromHtml("#B8CCE4"); var totals = XLColor.FromHtml("#D9E1F2");
        var shippedFill = XLColor.FromHtml("#DCE6F1"); var returnFill = XLColor.FromHtml("#E2EFDA");
        var debtPos = XLColor.FromHtml("#FFC7CE"); var debtZero = XLColor.FromHtml("#C6EFCE");
        var border = XLColor.FromHtml("#9DC3E6");

        var ws = wb.Worksheets.Add(name);
        void Style(IXLCell c, XLColor fill, bool bold, bool center = true)
        {
            c.Style.Font.FontName = "Calibri"; c.Style.Font.FontSize = 10; c.Style.Font.Bold = bold;
            c.Style.Fill.BackgroundColor = fill;
            c.Style.Alignment.Horizontal = center ? XLAlignmentHorizontalValues.Center : XLAlignmentHorizontalValues.Left;
            c.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
            c.Style.Alignment.WrapText = center;
            c.Style.Border.OutsideBorder = XLBorderStyleValues.Thin; c.Style.Border.OutsideBorderColor = border;
        }

        ws.Column(1).Width = 9; ws.Column(2).Width = 44;
        for (var i = 0; i < dates.Count; i++) { ws.Column(3 + i * 2).Width = 10; ws.Column(4 + i * 2).Width = 10; }
        var lastCol = 3 + dates.Count * 2;
        ws.Column(lastCol).Width = 14;

        // шапка: дата над парой «отгружено / возвращено»
        ws.Row(1).Height = 28; ws.Row(2).Height = 28;
        foreach (var (r, c) in new[] { (1, 1), (2, 1), (1, 2), (2, 2), (1, lastCol), (2, lastCol) }) Style(ws.Cell(r, c), header, true);
        ws.Cell(1, 2).Value = "Адрес получателя";
        ws.Range(1, 1, 2, 1).Merge(); ws.Range(1, 2, 2, 2).Merge();
        for (var i = 0; i < dates.Count; i++)
        {
            var col = 3 + i * 2;
            var p = dates[i].Split('-');
            ws.Cell(1, col).Value = $"{p[2]}.{p[1]}.{p[0]}";
            Style(ws.Cell(1, col), header, true); Style(ws.Cell(1, col + 1), header, true);
            ws.Range(1, col, 1, col + 1).Merge();
            ws.Cell(2, col).Value = "отгружено"; Style(ws.Cell(2, col), shippedFill, true);
            ws.Cell(2, col + 1).Value = "возвращено"; Style(ws.Cell(2, col + 1), returnFill, true);
        }
        ws.Cell(1, lastCol).Value = "итого долг по ЦФЗ";
        ws.Range(1, lastCol, 2, lastCol).Merge();

        var sumShipped = new double[dates.Count]; var sumReturned = new double[dates.Count];
        for (var ri = 0; ri < addresses.Count; ri++)
        {
            var addr = addresses[ri];
            var row = 3 + ri;
            ws.Row(row).Height = 18;
            var rowFill = ri % 2 == 0 ? XLColor.White : XLColor.FromHtml("#F2F7FC");
            ws.Cell(row, 1).Value = codes.TryGetValue(addr, out var code) ? code : ""; Style(ws.Cell(row, 1), rowFill, false);
            ws.Cell(row, 2).Value = addr; Style(ws.Cell(row, 2), rowFill, false, center: false);
            data.TryGetValue(addr, out var dm);
            double debt = 0;
            for (var i = 0; i < dates.Count; i++)
            {
                var col = 3 + i * 2;
                Cell? rec = null;
                dm?.TryGetValue(dates[i], out rec);
                double? shipped = rec != null ? shippedOf(rec) : null;
                double? returned = rec != null ? receivedOf(rec) : null;
                var sc = ws.Cell(row, col); if (shipped != null) sc.Value = shipped.Value; Style(sc, shipped != null ? shippedFill : rowFill, false);
                var rc = ws.Cell(row, col + 1); if (returned != null) rc.Value = returned.Value; Style(rc, returned != null ? returnFill : rowFill, false);
                debt += (shipped ?? 0) - (returned ?? 0);
                sumShipped[i] += shipped ?? 0; sumReturned[i] += returned ?? 0;
            }
            var dc = ws.Cell(row, lastCol); dc.Value = debt; Style(dc, debt > 0 ? debtPos : debtZero, true);
        }

        var tr = 3 + addresses.Count;
        ws.Row(tr).Height = 20;
        Style(ws.Cell(tr, 1), totals, false);
        ws.Cell(tr, 2).Value = "ИТОГО"; Style(ws.Cell(tr, 2), totals, true, center: false);
        for (var i = 0; i < dates.Count; i++)
        {
            var col = 3 + i * 2;
            if (sumShipped[i] != 0) ws.Cell(tr, col).Value = sumShipped[i];
            if (sumReturned[i] != 0) ws.Cell(tr, col + 1).Value = sumReturned[i];
            Style(ws.Cell(tr, col), totals, true); Style(ws.Cell(tr, col + 1), totals, true);
        }
        Style(ws.Cell(tr, lastCol), totals, false);
        ws.SheetView.FreezeRows(2);
    }
}
