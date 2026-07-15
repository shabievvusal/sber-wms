using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using BackendDotnet.Data;
using BackendDotnet.Models;
using BackendDotnet.Json;

namespace BackendDotnet.Services;

public class EoStoreResult
{
    public string? Address { get; set; }
    public List<Eo> Eos { get; set; } = new();
    public List<Eo> RemovedEos { get; set; } = new();
}

public class EoUpdateResult
{
    public List<Eo> Current { get; set; } = new();
    public List<Eo> Removed { get; set; } = new();
}

// Порт route-rk-pg.js (backend/) — та же таблица `routes` (создана Node,
// Фаза 0/USE_PG), тот же набор вычисляемых полей/агрегаций. Простые CRUD —
// через EF Core LINQ; JSONB-тяжёлые фильтры (getRoutes: status/даты) — сырой
// SQL через Npgsql, как в оригинале. Всё остальное (агрегации по водителям/
// ЦФЗ, поиск) — забираем ВСЕ строки через EF (без .Where на JSONB-полях,
// это не транслируется в SQL) и фильтруем/агрегируем в памяти, точно как
// это делает сам route-rk-pg.js в JS.
public class RouteService
{
    private static readonly CultureInfo Ru = new("ru-RU");
    private readonly AppDbContext _db;

    public RouteService(AppDbContext db)
    {
        _db = db;
    }

    private static string NowIso() => DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

    // ─── Вычисляемые поля (идентичны route-rk-pg.js) ───────────────────────

    private static double ShippedTotal(RouteEntity r) => r.Shipment?.Items.Sum(i => i.Rk) ?? 0;
    private static double ReceivedTotal(RouteEntity r) => r.Receiving?.Items.Sum(i => i.Rk) ?? 0;
    private static double ShippedPalletsTotal(RouteEntity r) => r.Shipment?.Items.Sum(i => i.Pallets) ?? 0;
    private static double ReceivedPalletsTotal(RouteEntity r) => r.Receiving?.Items.Sum(i => i.Pallets) ?? 0;
    private static double ShippedBoxesTotal(RouteEntity r) => r.Shipment?.Items.Sum(i => i.Boxes) ?? 0;
    private static double ReceivedBoxesTotal(RouteEntity r) => r.Receiving?.Items.Sum(i => i.Boxes) ?? 0;
    private static double ShippedThermalCoversTotal(RouteEntity r) => r.Shipment?.Items.Sum(i => i.ThermalCovers) ?? 0;
    private static double ReceivedThermalCoversTotal(RouteEntity r) => r.Receiving?.Items.Sum(i => i.ThermalCovers) ?? 0;

    private static double? CalcDiff(RouteEntity r)
    {
        if (r.Shipment == null || r.Receiving == null) return null;
        return ReceivedTotal(r) - ShippedTotal(r);
    }

    private static bool IsPartialShipment(RouteEntity r)
    {
        if (r.Shipment == null) return true;
        var shipped = r.Shipment.Items.Select(i => i.Address).ToHashSet();
        return r.CfzAddresses.Any(a => !shipped.Contains(a.Address));
    }

    private static bool IsPartialReceiving(RouteEntity r)
    {
        if (r.Receiving == null) return true;
        var received = r.Receiving.Items.Select(i => i.Address).ToHashSet();
        return r.CfzAddresses.Any(a => !received.Contains(a.Address));
    }

    public static RouteResponse WithTotals(RouteEntity r)
    {
        var shipRokhlya = r.Shipment?.Rokhlya ?? 0;
        var recvRokhlya = r.Receiving?.Rokhlya ?? 0;
        return new RouteResponse
        {
            RouteId = r.RouteId,
            RouteNumber = r.RouteNumber,
            Date = r.Date?.ToString("yyyy-MM-dd"),
            Driver = r.Driver,
            Vehicle = r.Vehicle,
            LogisticsCompany = r.LogisticsCompany,
            CfzAddresses = r.CfzAddresses,
            ImportedAt = r.ImportedAt,
            Shipment = r.Shipment,
            Receiving = r.Receiving,
            ShippedRK = r.Shipment != null ? ShippedTotal(r) : null,
            ReceivedRK = r.Receiving != null ? ReceivedTotal(r) : null,
            ShippedPallets = r.Shipment != null ? ShippedPalletsTotal(r) : null,
            ReceivedPallets = r.Receiving != null ? ReceivedPalletsTotal(r) : null,
            ShippedBoxes = r.Shipment != null ? ShippedBoxesTotal(r) : null,
            ReceivedBoxes = r.Receiving != null ? ReceivedBoxesTotal(r) : null,
            ShippedThermalCovers = r.Shipment != null ? ShippedThermalCoversTotal(r) : null,
            ReceivedThermalCovers = r.Receiving != null ? ReceivedThermalCoversTotal(r) : null,
            ShippedAt = r.Shipment?.At,
            ReceivedAt = r.Receiving?.At,
            Diff = CalcDiff(r),
            RokhlyaDebt = r.Shipment != null ? shipRokhlya - recvRokhlya : null,
        };
    }

    private static Item NormalizeItem(ItemRequest i) => new()
    {
        Address = i.Address ?? "",
        Rk = i.Rk,
        Pallets = i.Pallets ?? 0,
        Boxes = i.Boxes ?? 0,
        ThermalCovers = i.ThermalCovers ?? 0,
    };

    // ─── WMS импорт ─────────────────────────────────────────────────────────

    private static string? GetStr(JsonElement el, string prop)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static string? GetIdString(JsonElement el, string prop)
    {
        if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Number => v.GetRawText(),
            _ => null,
        };
    }

    private static double? GetDouble(JsonElement el, string prop)
    {
        if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(prop, out var v) || v.ValueKind != JsonValueKind.Number) return null;
        return v.GetDouble();
    }

    private record ParsedWmsRoute(string? RouteId, string? RouteNumber, DateOnly? Date, Driver? Driver, Vehicle? Vehicle, string? LogisticsCompany, List<CfzAddress> CfzAddresses);

    private static ParsedWmsRoute ParseWmsRoute(JsonElement json)
    {
        var route = json.ValueKind == JsonValueKind.Object && json.TryGetProperty("value", out var val) ? val : json;
        if (!route.TryGetProperty("stores", out var storesEl) || storesEl.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("Неверный формат маршрута");

        var dateStr = GetStr(route, "completedRouteDate");
        if (string.IsNullOrEmpty(dateStr)) dateStr = GetStr(route, "plannedRouteDate");
        dateStr = (dateStr ?? "").Length >= 10 ? dateStr!.Substring(0, 10) : (dateStr ?? "");
        DateOnly? date = DateOnly.TryParse(dateStr, out var d) ? d : null;

        Driver? driver = null;
        if (route.TryGetProperty("vehicleDriver", out var vd) && vd.ValueKind == JsonValueKind.Object)
        {
            var last = GetStr(vd, "lastName") ?? "";
            var first = GetStr(vd, "firstName") ?? "";
            var name = string.Join(" ", new[] { last, first }.Where(s => !string.IsNullOrEmpty(s)));
            driver = new Driver { Name = name, Phone = GetStr(vd, "phone") ?? "" };
        }

        Vehicle? vehicle = null;
        if (route.TryGetProperty("vehicle", out var veh) && veh.ValueKind == JsonValueKind.Object)
        {
            vehicle = new Vehicle { Number = GetStr(veh, "number") ?? "", Model = GetStr(veh, "model") ?? "" };
        }

        string? logisticsCompany = null;
        if (route.TryGetProperty("logisticsCompany", out var lc) && lc.ValueKind == JsonValueKind.Object)
        {
            logisticsCompany = GetStr(lc, "name");
        }

        var cfzAddresses = new List<CfzAddress>();
        foreach (var s in storesEl.EnumerateArray())
        {
            JsonElement rawEos = default;
            var hasEos = false;
            foreach (var field in new[] { "handlingUnits", "parcels", "items" })
            {
                if (s.TryGetProperty(field, out var arr) && arr.ValueKind == JsonValueKind.Array) { rawEos = arr; hasEos = true; break; }
            }
            var eos = new List<Eo>();
            if (hasEos)
            {
                foreach (var eo in rawEos.EnumerateArray())
                {
                    var barcode = GetIdString(eo, "barcode") ?? GetIdString(eo, "id") ?? GetIdString(eo, "handlingUnitBarcode") ?? GetIdString(eo, "code");
                    if (string.IsNullOrEmpty(barcode)) continue;
                    var weight = GetDouble(eo, "weight") ?? GetDouble(eo, "grossWeight");
                    eos.Add(new Eo { Barcode = barcode, Weight = weight });
                }
            }
            var address = (GetStr(s, "address") ?? "").Trim();
            if (string.IsNullOrEmpty(address)) continue;
            cfzAddresses.Add(new CfzAddress { Address = address, StoreId = GetIdString(s, "id"), Eos = eos });
        }

        var routeId = GetIdString(route, "id");
        var routeNumber = GetStr(route, "routeNumber");
        return new ParsedWmsRoute(routeId, routeNumber, date, driver, vehicle, logisticsCompany, cfzAddresses);
    }

    private static List<CfzAddress> MergeCfz(List<CfzAddress> parsed, List<CfzAddress> existing)
        => parsed.Select(c =>
        {
            if (c.Eos.Count > 0) return c;
            var old = existing.FirstOrDefault(o => o.StoreId == c.StoreId);
            return new CfzAddress { Address = c.Address, StoreId = c.StoreId, Eos = old?.Eos ?? new List<Eo>(), RemovedEos = c.RemovedEos };
        }).ToList();

    public async Task<(int Added, int Updated)> ImportRouteAsync(JsonElement json)
    {
        var parsed = ParseWmsRoute(json);
        if (string.IsNullOrEmpty(parsed.RouteId)) throw new InvalidOperationException("Маршрут без ID");

        var existing = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == parsed.RouteId);
        if (existing != null)
        {
            existing.RouteNumber = parsed.RouteNumber;
            existing.Date = parsed.Date;
            existing.Driver = parsed.Driver;
            existing.Vehicle = parsed.Vehicle;
            existing.LogisticsCompany = parsed.LogisticsCompany;
            existing.CfzAddresses = MergeCfz(parsed.CfzAddresses, existing.CfzAddresses);
            await _db.SaveChangesAsync();
            return (0, 1);
        }

        _db.Routes.Add(new RouteEntity
        {
            RouteId = parsed.RouteId!,
            RouteNumber = parsed.RouteNumber,
            Date = parsed.Date,
            Driver = parsed.Driver,
            Vehicle = parsed.Vehicle,
            LogisticsCompany = parsed.LogisticsCompany,
            CfzAddresses = parsed.CfzAddresses,
            ImportedAt = DateTime.UtcNow,
        });
        await _db.SaveChangesAsync();
        return (1, 0);
    }

    public async Task<(int Added, int Updated)> ImportBulkAsync(List<JsonElement> routeJsons)
    {
        int added = 0, updated = 0;
        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            foreach (var json in routeJsons)
            {
                try
                {
                    var parsed = ParseWmsRoute(json);
                    if (string.IsNullOrEmpty(parsed.RouteId)) continue;
                    var existing = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == parsed.RouteId);
                    if (existing != null)
                    {
                        existing.RouteNumber = parsed.RouteNumber;
                        existing.Date = parsed.Date;
                        existing.Driver = parsed.Driver;
                        existing.Vehicle = parsed.Vehicle;
                        existing.LogisticsCompany = parsed.LogisticsCompany;
                        existing.CfzAddresses = MergeCfz(parsed.CfzAddresses, existing.CfzAddresses);
                        updated++;
                    }
                    else
                    {
                        _db.Routes.Add(new RouteEntity
                        {
                            RouteId = parsed.RouteId!,
                            RouteNumber = parsed.RouteNumber,
                            Date = parsed.Date,
                            Driver = parsed.Driver,
                            Vehicle = parsed.Vehicle,
                            LogisticsCompany = parsed.LogisticsCompany,
                            CfzAddresses = parsed.CfzAddresses,
                            ImportedAt = DateTime.UtcNow,
                        });
                        added++;
                    }
                    await _db.SaveChangesAsync();
                }
                catch { /* пропускаем, как и в оригинале */ }
            }
            await tx.CommitAsync();
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
        return (added, updated);
    }

    // ─── Отгрузка / Приёмка ─────────────────────────────────────────────────

    public async Task<RouteResponse> SubmitShipmentAsync(string routeId, ShipmentRequest req)
    {
        var route = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == routeId) ?? throw new InvalidOperationException("Маршрут не найден");
        route.Shipment = new ShipmentInfo
        {
            By = req.By, Gate = req.Gate, TempBefore = req.TempBefore, TempAfter = req.TempAfter, Rokhlya = req.Rokhlya,
            At = NowIso(), Confirmed = false, ConfirmedAt = null,
            Photos = req.Photos ?? new(), Items = (req.Items ?? new()).Select(NormalizeItem).ToList(),
        };
        await _db.SaveChangesAsync();
        return WithTotals(route);
    }

    public async Task<RouteResponse> SubmitReceivingAsync(string routeId, ReceivingRequest req)
    {
        var route = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == routeId) ?? throw new InvalidOperationException("Маршрут не найден");
        route.Receiving = new ReceivingInfo
        {
            By = req.By, Gate = req.Gate, Rokhlya = req.Rokhlya,
            At = NowIso(), Confirmed = false, ConfirmedAt = null,
            Photos = req.Photos ?? new(), Items = (req.Items ?? new()).Select(NormalizeItem).ToList(),
        };
        await _db.SaveChangesAsync();
        return WithTotals(route);
    }

    public async Task<RouteResponse> UpdateShipmentAsync(string routeId, ShipmentRequest req)
    {
        var route = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == routeId) ?? throw new InvalidOperationException("Маршрут не найден");
        if (req.Items == null || req.Items.Count == 0)
        {
            route.Shipment = null;
            await _db.SaveChangesAsync();
            return WithTotals(route);
        }
        var ex = route.Shipment;
        route.Shipment = new ShipmentInfo
        {
            By = !string.IsNullOrEmpty(req.By) ? req.By : ex?.By,
            Gate = !string.IsNullOrEmpty(req.Gate) ? req.Gate : ex?.Gate,
            TempBefore = req.TempBefore ?? ex?.TempBefore,
            TempAfter = req.TempAfter ?? ex?.TempAfter,
            Rokhlya = req.Rokhlya ?? ex?.Rokhlya,
            At = ex?.At ?? NowIso(),
            Confirmed = ex?.Confirmed ?? false,
            ConfirmedAt = ex?.ConfirmedAt,
            UpdatedAt = NowIso(),
            Photos = req.Photos ?? ex?.Photos ?? new(),
            Items = req.Items.Select(NormalizeItem).ToList(),
        };
        await _db.SaveChangesAsync();
        return WithTotals(route);
    }

    public async Task<RouteResponse> UpdateReceivingAsync(string routeId, ReceivingRequest req)
    {
        var route = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == routeId) ?? throw new InvalidOperationException("Маршрут не найден");
        if (req.Items == null || req.Items.Count == 0)
        {
            route.Receiving = null;
            await _db.SaveChangesAsync();
            return WithTotals(route);
        }
        var ex = route.Receiving;
        route.Receiving = new ReceivingInfo
        {
            By = !string.IsNullOrEmpty(req.By) ? req.By : ex?.By,
            Gate = !string.IsNullOrEmpty(req.Gate) ? req.Gate : ex?.Gate,
            Rokhlya = req.Rokhlya ?? ex?.Rokhlya,
            At = ex?.At ?? NowIso(),
            Confirmed = ex?.Confirmed ?? false,
            ConfirmedAt = ex?.ConfirmedAt,
            UpdatedAt = NowIso(),
            Photos = req.Photos ?? ex?.Photos ?? new(),
            Items = req.Items.Select(NormalizeItem).ToList(),
        };
        await _db.SaveChangesAsync();
        return WithTotals(route);
    }

    public async Task<RouteResponse> ConfirmShipmentAsync(string routeId, string? confirmedBy)
    {
        var route = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == routeId) ?? throw new InvalidOperationException("Маршрут не найден");
        var cur = route.Shipment ?? throw new InvalidOperationException("Нет данных об отгрузке");
        route.Shipment = new ShipmentInfo
        {
            By = cur.By, Gate = cur.Gate, TempBefore = cur.TempBefore, TempAfter = cur.TempAfter, Rokhlya = cur.Rokhlya,
            At = cur.At, Photos = cur.Photos, Items = cur.Items, UpdatedAt = cur.UpdatedAt,
            Confirmed = true, ConfirmedAt = NowIso(), ConfirmedBy = confirmedBy,
        };
        await _db.SaveChangesAsync();
        return WithTotals(route);
    }

    public async Task<RouteResponse> ConfirmReceivingAsync(string routeId, string? confirmedBy)
    {
        var route = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == routeId) ?? throw new InvalidOperationException("Маршрут не найден");
        var cur = route.Receiving ?? throw new InvalidOperationException("Нет данных о приёмке");
        route.Receiving = new ReceivingInfo
        {
            By = cur.By, Gate = cur.Gate, Rokhlya = cur.Rokhlya,
            At = cur.At, Photos = cur.Photos, Items = cur.Items, UpdatedAt = cur.UpdatedAt,
            Confirmed = true, ConfirmedAt = NowIso(), ConfirmedBy = confirmedBy,
        };
        await _db.SaveChangesAsync();
        return WithTotals(route);
    }

    public async Task<RouteResponse> UpdateRouteDriverAsync(string routeId, DriverUpdateRequest req)
    {
        var route = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == routeId) ?? throw new InvalidOperationException("Маршрут не найден");
        var trimmedName = (req.Name ?? "").Trim();
        var phone = req.Phone ?? route.Driver?.Phone ?? "";
        route.Driver = new Driver { Name = string.IsNullOrEmpty(trimmedName) ? null : trimmedName, Phone = phone };
        await _db.SaveChangesAsync();
        return WithTotals(route);
    }

    // ─── Запросы ─────────────────────────────────────────────────────────────

    public async Task<List<RouteResponse>> GetRoutesAsync(string? q, string? dateFrom, string? dateTo, string? receivedDateFrom, string? receivedDateTo, string? status)
    {
        var sql = new System.Text.StringBuilder("SELECT * FROM routes WHERE 1=1");
        var parameters = new List<object>();

        if (status == "unshipped") sql.Append(" AND shipment IS NULL");
        else if (status == "pending") sql.Append(" AND shipment IS NOT NULL");
        else if (status == "done") sql.Append(" AND shipment IS NOT NULL AND receiving IS NOT NULL");

        if (!string.IsNullOrEmpty(dateFrom)) { parameters.Add(dateFrom); sql.Append($" AND date >= ${parameters.Count}::date"); }
        if (!string.IsNullOrEmpty(dateTo)) { parameters.Add(dateTo); sql.Append($" AND date <= ${parameters.Count}::date"); }
        if (!string.IsNullOrEmpty(receivedDateFrom)) { parameters.Add(receivedDateFrom); sql.Append($" AND (receiving->>'at')::date >= ${parameters.Count}::date"); }
        if (!string.IsNullOrEmpty(receivedDateTo)) { parameters.Add(receivedDateTo); sql.Append($" AND (receiving->>'at')::date <= ${parameters.Count}::date"); }
        if (!string.IsNullOrEmpty(status) && string.IsNullOrEmpty(dateFrom) && string.IsNullOrEmpty(dateTo))
        {
            parameters.Add(90);
            sql.Append($" AND date >= (CURRENT_DATE - (${parameters.Count} || ' days')::interval)::date");
        }
        sql.Append(" ORDER BY date DESC NULLS LAST");

        var routes = await QueryRoutesRawAsync(sql.ToString(), parameters);

        IEnumerable<RouteEntity> filtered = routes;
        if (status == "unshipped") filtered = filtered.Where(IsPartialShipment);
        else if (status == "pending") filtered = filtered.Where(r => !IsPartialShipment(r) && IsPartialReceiving(r));

        var result = filtered.Select(WithTotals).ToList();

        if (!string.IsNullOrEmpty(q))
        {
            var ql = q.Trim().ToLowerInvariant();
            result = result.Where(r =>
                (r.RouteNumber ?? "").ToLowerInvariant().Contains(ql) ||
                (r.Driver?.Name ?? "").ToLowerInvariant().Contains(ql) ||
                (r.Vehicle?.Number ?? "").ToLowerInvariant().Contains(ql) ||
                (r.LogisticsCompany ?? "").ToLowerInvariant().Contains(ql) ||
                r.CfzAddresses.Any(a => (a.Address ?? "").ToLowerInvariant().Contains(ql))
            ).ToList();
        }
        return result;
    }

    public async Task<RouteResponse?> GetRouteByIdAsync(string routeId)
    {
        var route = await _db.Routes.AsNoTracking().FirstOrDefaultAsync(r => r.RouteId == routeId);
        return route == null ? null : WithTotals(route);
    }

    public async Task<List<DriverAggregate>> GetByDriverAsync(string? q)
    {
        var routes = (await _db.Routes.AsNoTracking().ToListAsync()).OrderByDescending(r => r.Date).ToList();
        var ql = (q ?? "").Trim().ToLowerInvariant();
        var map = new Dictionary<string, DriverAggregate>();

        foreach (var raw in routes)
        {
            var route = WithTotals(raw);
            var name = route.Driver?.Name ?? "(без водителя)";
            if (!string.IsNullOrEmpty(ql) && !name.ToLowerInvariant().Contains(ql)) continue;
            if (!map.TryGetValue(name, out var d))
            {
                d = new DriverAggregate { Name = name, Phone = route.Driver?.Phone ?? "" };
                map[name] = d;
            }
            d.RouteCount++;
            if (route.ShippedRK != null) d.ShippedTotal += route.ShippedRK.Value;
            if (route.ReceivedRK != null) d.ReceivedTotal += route.ReceivedRK.Value;
            if (route.ShippedPallets != null) d.ShippedPallets += route.ShippedPallets.Value;
            if (route.ReceivedPallets != null) d.ReceivedPallets += route.ReceivedPallets.Value;
            if (route.ShippedBoxes != null) d.ShippedBoxes += route.ShippedBoxes.Value;
            if (route.ReceivedBoxes != null) d.ReceivedBoxes += route.ReceivedBoxes.Value;
            if (route.ShippedThermalCovers != null) d.ShippedThermalCovers += route.ShippedThermalCovers.Value;
            if (route.ReceivedThermalCovers != null) d.ReceivedThermalCovers += route.ReceivedThermalCovers.Value;
            if (route.Shipment != null) d.ShippedRokhlya += route.Shipment.Rokhlya ?? 0;
            if (route.Receiving != null) d.ReceivedRokhlya += route.Receiving.Rokhlya ?? 0;
            d.Routes.Add(new AggregateRouteRow
            {
                RouteId = route.RouteId, RouteNumber = route.RouteNumber, Date = route.Date,
                Vehicle = route.Vehicle, CfzAddresses = route.CfzAddresses,
                ShippedRK = route.ShippedRK, ReceivedRK = route.ReceivedRK, Diff = route.Diff,
                ShippedAt = route.ShippedAt, ReceivedAt = route.ReceivedAt,
                ShippedPallets = route.ShippedPallets, ReceivedPallets = route.ReceivedPallets,
                ShippedThermalCovers = route.ShippedThermalCovers, ReceivedThermalCovers = route.ReceivedThermalCovers,
                ShippedRokhlya = route.Shipment?.Rokhlya ?? 0,
                ReceivedRokhlya = route.Receiving?.Rokhlya ?? 0,
            });
        }

        foreach (var d in map.Values)
        {
            d.Diff = (d.ShippedTotal > 0 || d.ReceivedTotal > 0) ? d.ReceivedTotal - d.ShippedTotal : null;
            d.RokhlyaDebt = d.ShippedRokhlya - d.ReceivedRokhlya;
            d.Routes = d.Routes.OrderByDescending(r => r.Date ?? "", StringComparer.Ordinal).ToList();
        }
        return map.Values.OrderBy(d => d.Name, StringComparer.Create(Ru, false)).ToList();
    }

    public async Task<List<CfzAggregate>> GetByCfzAsync(string? q)
    {
        var routes = (await _db.Routes.AsNoTracking().ToListAsync()).OrderByDescending(r => r.Date).ToList();
        var ql = (q ?? "").Trim().ToLowerInvariant();
        var map = new Dictionary<string, CfzAggregate>();

        foreach (var raw in routes)
        {
            var route = WithTotals(raw);
            foreach (var cfz in route.CfzAddresses)
            {
                var addr = cfz.Address ?? "";
                var driverName = route.Driver?.Name ?? "";
                if (!string.IsNullOrEmpty(ql) && !addr.ToLowerInvariant().Contains(ql) && !driverName.ToLowerInvariant().Contains(ql)) continue;
                if (!map.TryGetValue(addr, out var c))
                {
                    c = new CfzAggregate { Address = addr, StoreId = cfz.StoreId };
                    map[addr] = c;
                }
                c.RouteCount++;

                var shippedItem = route.Shipment?.Items.FirstOrDefault(i => i.Address == addr);
                var receivedItem = route.Receiving?.Items.FirstOrDefault(i => i.Address == addr);
                double? cfzShipped = shippedItem?.Rk;
                double? cfzReceived = receivedItem?.Rk;
                double? cfzShippedPallets = shippedItem?.Pallets;
                double? cfzReceivedPallets = receivedItem?.Pallets;
                double? cfzShippedBoxes = shippedItem?.Boxes;
                double? cfzReceivedBoxes = receivedItem?.Boxes;
                double? cfzShippedThermalCovers = shippedItem?.ThermalCovers;
                double? cfzReceivedThermalCovers = receivedItem?.ThermalCovers;

                if (cfzShipped != null) c.ShippedTotal += cfzShipped.Value;
                if (cfzReceived != null) c.ReceivedTotal += cfzReceived.Value;
                if (cfzShippedPallets != null) c.ShippedPallets += cfzShippedPallets.Value;
                if (cfzReceivedPallets != null) c.ReceivedPallets += cfzReceivedPallets.Value;
                if (cfzShippedBoxes != null) c.ShippedBoxes += cfzShippedBoxes.Value;
                if (cfzReceivedBoxes != null) c.ReceivedBoxes += cfzReceivedBoxes.Value;
                if (cfzShippedThermalCovers != null) c.ShippedThermalCovers += cfzShippedThermalCovers.Value;
                if (cfzReceivedThermalCovers != null) c.ReceivedThermalCovers += cfzReceivedThermalCovers.Value;

                c.Routes.Add(new AggregateRouteRow
                {
                    RouteId = route.RouteId, RouteNumber = route.RouteNumber, Date = route.Date,
                    Driver = route.Driver, Vehicle = route.Vehicle,
                    ShippedRK = cfzShipped, ReceivedRK = cfzReceived,
                    ShippedAt = route.Shipment?.At, ReceivedAt = route.Receiving?.At,
                    Diff = (cfzShipped != null && cfzReceived != null) ? cfzReceived - cfzShipped : null,
                    ShippedPallets = cfzShippedPallets, ReceivedPallets = cfzReceivedPallets,
                    ShippedBoxes = cfzShippedBoxes, ReceivedBoxes = cfzReceivedBoxes,
                    ShippedThermalCovers = cfzShippedThermalCovers, ReceivedThermalCovers = cfzReceivedThermalCovers,
                });
            }
        }

        foreach (var c in map.Values)
        {
            c.Diff = (c.ShippedTotal > 0 || c.ReceivedTotal > 0) ? c.ReceivedTotal - c.ShippedTotal : null;
            c.Routes = c.Routes.OrderByDescending(r => r.Date ?? "", StringComparer.Ordinal).ToList();
        }
        return map.Values.OrderBy(c => c.Address, StringComparer.Create(Ru, false)).ToList();
    }

    public async Task<List<DriverPendingSummary>> GetDriversWithPendingAsync(string? q)
    {
        var cutoff = DateOnly.FromDateTime(DateTime.UtcNow.Date.AddDays(-90));
        var rows = await _db.Routes.AsNoTracking().Where(r => r.Shipment != null && r.Date >= cutoff).ToListAsync();
        return AggregateDriverPending(rows, q, r => !IsPartialShipment(r) && IsPartialReceiving(r));
    }

    public async Task<List<DriverPendingSummary>> GetDriversUnshippedAsync(string? q)
    {
        var cutoff = DateOnly.FromDateTime(DateTime.UtcNow.Date.AddDays(-90));
        var rows = await _db.Routes.AsNoTracking().Where(r => r.Shipment == null && r.Date >= cutoff).ToListAsync();
        return AggregateDriverPending(rows, q, IsPartialShipment);
    }

    private static List<DriverPendingSummary> AggregateDriverPending(List<RouteEntity> rows, string? q, Func<RouteEntity, bool> extraCondition)
    {
        var ql = (q ?? "").Trim().ToLowerInvariant();
        var map = new Dictionary<string, DriverPendingSummary>();
        foreach (var route in rows)
        {
            if (!extraCondition(route) || route.CfzAddresses.Count == 0) continue;
            var name = route.Driver?.Name ?? "";
            if (!string.IsNullOrEmpty(ql) && !name.ToLowerInvariant().Contains(ql)) continue;
            if (!map.TryGetValue(name, out var d))
            {
                d = new DriverPendingSummary { Name = name, Phone = route.Driver?.Phone ?? "" };
                map[name] = d;
            }
            d.RouteCount++;
            var dateStr = route.Date?.ToString("yyyy-MM-dd") ?? "";
            if (string.CompareOrdinal(dateStr, d.LatestDate) > 0) d.LatestDate = dateStr;
        }
        return map.Values.OrderBy(d => d.Name, StringComparer.Create(Ru, false)).ToList();
    }

    public async Task<List<RouteResponse>> GetRoutesByDriverPendingAsync(string driverName)
    {
        var rows = await _db.Routes.AsNoTracking().ToListAsync();
        return rows.Where(r => r.Driver?.Name == driverName).Select(WithTotals)
            .OrderByDescending(r => r.Date ?? "", StringComparer.Ordinal).ToList();
    }

    public async Task<List<RouteResponse>> GetRoutesByDriverUnshippedAsync(string driverName)
    {
        var rows = (await _db.Routes.AsNoTracking().ToListAsync()).OrderByDescending(r => r.Date).ToList();
        return rows.Where(r => r.Driver?.Name == driverName)
            .Where(r => IsPartialShipment(r) && r.CfzAddresses.Count > 0)
            .Select(WithTotals).ToList();
    }

    public async Task<List<string>> GetAddressesAsync()
    {
        var routes = await _db.Routes.AsNoTracking().ToListAsync();
        var set = new HashSet<string>();
        foreach (var r in routes)
            foreach (var a in r.CfzAddresses)
                if (!string.IsNullOrEmpty(a.Address)) set.Add(a.Address);
        return set.OrderBy(a => a, StringComparer.Create(Ru, false)).ToList();
    }

    private class ReportCell
    {
        public double Shipped;
        public double? Received;
        public double ShippedBoxes;
        public double? ReceivedBoxes;
        public double ShippedThermalCovers;
        public double? ReceivedThermalCovers;
    }

    public async Task<List<ReportAddressRow>> GetReportDataAsync(string dateFrom, string dateTo)
    {
        var routes = await _db.Routes.AsNoTracking().ToListAsync();
        var map = new Dictionary<string, Dictionary<string, ReportCell>>();

        ReportCell EnsureCell(string addr, string date)
        {
            if (!map.TryGetValue(addr, out var dm)) { dm = new(); map[addr] = dm; }
            if (!dm.TryGetValue(date, out var cell)) { cell = new ReportCell(); dm[date] = cell; }
            return cell;
        }

        foreach (var route in routes)
        {
            if (route.Shipment != null)
            {
                var shipDateFull = route.Shipment.At ?? route.Date?.ToString("yyyy-MM-dd") ?? "";
                var shipDate = shipDateFull.Length >= 10 ? shipDateFull[..10] : shipDateFull;
                if (string.CompareOrdinal(shipDate, dateFrom) >= 0 && string.CompareOrdinal(shipDate, dateTo) <= 0)
                {
                    foreach (var item in route.Shipment.Items)
                    {
                        var cell = EnsureCell(item.Address, shipDate);
                        cell.Shipped += item.Rk;
                        if (item.Boxes != 0) cell.ShippedBoxes += item.Boxes;
                        if (item.ThermalCovers != 0) cell.ShippedThermalCovers += item.ThermalCovers;
                    }
                }
            }
            if (route.Receiving != null)
            {
                var recvDateFull = route.Receiving.At ?? route.Date?.ToString("yyyy-MM-dd") ?? "";
                var recvDate = recvDateFull.Length >= 10 ? recvDateFull[..10] : recvDateFull;
                if (string.CompareOrdinal(recvDate, dateFrom) >= 0 && string.CompareOrdinal(recvDate, dateTo) <= 0)
                {
                    foreach (var item in route.Receiving.Items)
                    {
                        var cell = EnsureCell(item.Address, recvDate);
                        cell.Received = (cell.Received ?? 0) + item.Rk;
                        if (item.Boxes != 0) cell.ReceivedBoxes = (cell.ReceivedBoxes ?? 0) + item.Boxes;
                        if (item.ThermalCovers != 0) cell.ReceivedThermalCovers = (cell.ReceivedThermalCovers ?? 0) + item.ThermalCovers;
                    }
                }
            }
        }

        return map.Select(kv => new ReportAddressRow
        {
            Address = kv.Key,
            Records = kv.Value
                .Where(dv => dv.Value.Shipped > 0 || dv.Value.Received != null || dv.Value.ShippedBoxes > 0 || dv.Value.ReceivedBoxes != null || dv.Value.ShippedThermalCovers > 0 || dv.Value.ReceivedThermalCovers != null)
                .Select(dv => new ReportRecord
                {
                    Date = dv.Key, Shipped = dv.Value.Shipped, Received = dv.Value.Received,
                    ShippedBoxes = dv.Value.ShippedBoxes, ReceivedBoxes = dv.Value.ReceivedBoxes,
                    ShippedThermalCovers = dv.Value.ShippedThermalCovers, ReceivedThermalCovers = dv.Value.ReceivedThermalCovers,
                })
                .OrderBy(r => r.Date, StringComparer.Ordinal)
                .ToList(),
        })
        .Where(e => e.Records.Count > 0)
        .OrderBy(e => e.Address, StringComparer.Create(Ru, false))
        .ToList();
    }

    public async Task<int> DeleteRoutesByIdsAsync(List<string> ids)
    {
        if (ids.Count == 0) return 0;
        return await _db.Routes.Where(r => ids.Contains(r.RouteId)).ExecuteDeleteAsync();
    }

    public async Task<int> DeleteRoutesByDateRangeAsync(string dateFrom, string dateTo)
    {
        if (string.IsNullOrEmpty(dateFrom) || string.IsNullOrEmpty(dateTo)) throw new InvalidOperationException("Укажите период");
        var from = DateOnly.Parse(dateFrom);
        var to = DateOnly.Parse(dateTo);
        return await _db.Routes.Where(r => r.Date >= from && r.Date <= to).ExecuteDeleteAsync();
    }

    // ─── ЕО ──────────────────────────────────────────────────────────────────

    public async Task<Dictionary<string, EoStoreResult>?> GetRouteEosAsync(string routeId)
    {
        var route = await _db.Routes.AsNoTracking().FirstOrDefaultAsync(r => r.RouteId == routeId);
        if (route == null) return null;
        var result = new Dictionary<string, EoStoreResult>();
        foreach (var cfz in route.CfzAddresses)
        {
            if (string.IsNullOrEmpty(cfz.StoreId)) continue;
            result[cfz.StoreId] = new EoStoreResult { Address = cfz.Address, Eos = cfz.Eos, RemovedEos = cfz.RemovedEos };
        }
        return result;
    }

    public async Task<Dictionary<string, EoUpdateResult>> UpdateRouteEosBatchAsync(string routeId, JsonElement stores)
    {
        var route = await _db.Routes.FirstOrDefaultAsync(r => r.RouteId == routeId) ?? throw new InvalidOperationException("Маршрут не найден");
        var cfzAddresses = route.CfzAddresses;
        var results = new Dictionary<string, EoUpdateResult>();

        if (stores.ValueKind == JsonValueKind.Array)
        {
            foreach (var store in stores.EnumerateArray())
            {
                var storeId = GetIdString(store, "id");
                if (string.IsNullOrEmpty(storeId)) continue;
                var cfz = cfzAddresses.FirstOrDefault(c => c.StoreId == storeId);
                if (cfz == null) continue;

                JsonElement rawEos = default;
                var hasEos = false;
                foreach (var field in new[] { "handlingUnits", "parcels", "items" })
                {
                    if (store.TryGetProperty(field, out var arr) && arr.ValueKind == JsonValueKind.Array) { rawEos = arr; hasEos = true; break; }
                }
                var newEos = new List<Eo>();
                if (hasEos)
                {
                    foreach (var eo in rawEos.EnumerateArray())
                    {
                        var barcode = GetIdString(eo, "barcode") ?? GetIdString(eo, "id") ?? GetIdString(eo, "handlingUnitBarcode") ?? GetIdString(eo, "code");
                        if (string.IsNullOrEmpty(barcode)) continue;
                        var weight = GetDouble(eo, "weight") ?? GetDouble(eo, "grossWeight");
                        newEos.Add(new Eo { Barcode = barcode, Weight = weight });
                    }
                }

                var newBarcodes = newEos.Select(e => e.Barcode).ToHashSet();
                var newlyRemoved = cfz.Eos.Where(e => !newBarcodes.Contains(e.Barcode)).ToList();
                var existingRemoved = cfz.RemovedEos;
                var existingRemovedBarcodes = existingRemoved.Select(e => e.Barcode).ToHashSet();
                var allRemoved = existingRemoved.Concat(newlyRemoved.Where(e => !existingRemovedBarcodes.Contains(e.Barcode))).ToList();

                cfz.Eos = newEos;
                cfz.RemovedEos = allRemoved;
                results[storeId] = new EoUpdateResult { Current = newEos, Removed = allRemoved };
            }
        }

        // Новая ссылка на список — гарантированно ловится трекингом изменений EF.
        route.CfzAddresses = new List<CfzAddress>(cfzAddresses);
        await _db.SaveChangesAsync();
        return results;
    }

    // ─── Поиск (страница кладовщика) ────────────────────────────────────────

    public async Task<List<RouteResponse>> SearchRoutesAsync(string? q, string? mode)
    {
        var routes = (await _db.Routes.AsNoTracking().ToListAsync()).OrderByDescending(r => r.Date).ToList();
        IEnumerable<RouteEntity> filtered = routes;
        if (mode == "unshipped") filtered = filtered.Where(IsPartialShipment);
        else if (mode == "pending") filtered = filtered.Where(r => !IsPartialShipment(r) && IsPartialReceiving(r));

        var ql = (q ?? "").Trim().ToLowerInvariant();
        if (!string.IsNullOrEmpty(ql))
        {
            filtered = filtered.Where(r =>
                (r.RouteNumber ?? "").ToLowerInvariant().Contains(ql) ||
                (r.Driver?.Name ?? "").ToLowerInvariant().Contains(ql) ||
                (r.Vehicle?.Number ?? "").ToLowerInvariant().Contains(ql) ||
                r.CfzAddresses.Any(a => (a.Address ?? "").ToLowerInvariant().Contains(ql)));
        }
        return filtered.Select(WithTotals).ToList();
    }

    public async Task<DriverRokhlyaDebtResponse> GetDriverRokhlyaDebtAsync(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return new DriverRokhlyaDebtResponse { RokhlyaDebt = 0, DebtSince = null };
        var drivers = await GetByDriverAsync(name);
        var driver = drivers.FirstOrDefault(d => d.Name == name) ?? drivers.FirstOrDefault();
        if (driver == null) return new DriverRokhlyaDebtResponse { RokhlyaDebt = 0, DebtSince = null };
        var debtRoute = driver.Routes
            .Where(r => (r.ShippedRokhlya - r.ReceivedRokhlya) > 0)
            .OrderBy(r => r.Date ?? "", StringComparer.Ordinal)
            .FirstOrDefault();
        return new DriverRokhlyaDebtResponse
        {
            RokhlyaDebt = driver.RokhlyaDebt,
            DebtSince = debtRoute != null ? new DebtSince { Date = debtRoute.Date ?? "", RouteNumber = debtRoute.RouteNumber } : null,
        };
    }

    // ─── Сырой SQL для GetRoutesAsync (динамические фильтры, как в оригинале) ─

    private async Task<List<RouteEntity>> QueryRoutesRawAsync(string sql, List<object> parameters)
    {
        var conn = (NpgsqlConnection)_db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        foreach (var p in parameters) cmd.Parameters.AddWithValue(p);
        var result = new List<RouteEntity>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync()) result.Add(MapRow(reader));
        return result;
    }

    private static RouteEntity MapRow(NpgsqlDataReader r)
    {
        return new RouteEntity
        {
            RouteId = r.GetString(r.GetOrdinal("route_id")),
            RouteNumber = NullableString(r, "route_number"),
            Date = r.IsDBNull(r.GetOrdinal("date")) ? null : r.GetFieldValue<DateOnly>(r.GetOrdinal("date")),
            Driver = DeserializeJsonb<Driver>(r, "driver"),
            Vehicle = DeserializeJsonb<Vehicle>(r, "vehicle"),
            LogisticsCompany = NullableString(r, "logistics_company"),
            CfzAddresses = DeserializeJsonbList<CfzAddress>(r, "cfz_addresses") ?? new(),
            ImportedAt = r.IsDBNull(r.GetOrdinal("imported_at")) ? null : r.GetDateTime(r.GetOrdinal("imported_at")),
            Shipment = DeserializeJsonb<ShipmentInfo>(r, "shipment"),
            Receiving = DeserializeJsonb<ReceivingInfo>(r, "receiving"),
        };
    }

    private static string? NullableString(NpgsqlDataReader r, string col)
    {
        var i = r.GetOrdinal(col);
        return r.IsDBNull(i) ? null : r.GetString(i);
    }

    private static T? DeserializeJsonb<T>(NpgsqlDataReader r, string col) where T : class
    {
        var i = r.GetOrdinal(col);
        if (r.IsDBNull(i)) return null;
        var raw = r.GetString(i);
        return string.IsNullOrEmpty(raw) ? null : JsonSerializer.Deserialize<T>(raw, JsonOptions.Default);
    }

    private static List<T>? DeserializeJsonbList<T>(NpgsqlDataReader r, string col)
    {
        var i = r.GetOrdinal(col);
        if (r.IsDBNull(i)) return new List<T>();
        var raw = r.GetString(i);
        return string.IsNullOrEmpty(raw) ? new List<T>() : JsonSerializer.Deserialize<List<T>>(raw, JsonOptions.Default);
    }
}
