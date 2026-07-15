namespace BackendDotnet.Models;

// Ответ API на маршрут — то же самое, что возвращает withTotals() в
// route-rk-pg.js: сама запись + вычисляемые поля. Node пишет null-поля в
// JSON как есть (JSON.stringify не убирает null), поэтому здесь не
// используется JsonIgnoreCondition.WhenWritingNull — контракт должен
// совпадать 1-в-1.
public class RouteResponse
{
    public string RouteId { get; set; } = "";
    public string? RouteNumber { get; set; }
    public string? Date { get; set; }
    public Driver? Driver { get; set; }
    public Vehicle? Vehicle { get; set; }
    public string? LogisticsCompany { get; set; }
    public List<CfzAddress> CfzAddresses { get; set; } = new();
    public DateTime? ImportedAt { get; set; }
    public ShipmentInfo? Shipment { get; set; }
    public ReceivingInfo? Receiving { get; set; }

    public double? ShippedRK { get; set; }
    public double? ReceivedRK { get; set; }
    public double? ShippedPallets { get; set; }
    public double? ReceivedPallets { get; set; }
    public double? ShippedBoxes { get; set; }
    public double? ReceivedBoxes { get; set; }
    public double? ShippedThermalCovers { get; set; }
    public double? ReceivedThermalCovers { get; set; }
    public string? ShippedAt { get; set; }
    public string? ReceivedAt { get; set; }
    public double? Diff { get; set; }
    public double? RokhlyaDebt { get; set; }
}

// Плоская запись маршрута внутри агрегатов (getByDriver/getByCfz) — то же
// самое, что и `d.routes.push({...})`/`c.routes.push({...})` в оригинале.
public class AggregateRouteRow
{
    public string RouteId { get; set; } = "";
    public string? RouteNumber { get; set; }
    public string? Date { get; set; }
    public Driver? Driver { get; set; }
    public Vehicle? Vehicle { get; set; }
    public List<CfzAddress>? CfzAddresses { get; set; }
    public double? ShippedRK { get; set; }
    public double? ReceivedRK { get; set; }
    public double? Diff { get; set; }
    public string? ShippedAt { get; set; }
    public string? ReceivedAt { get; set; }
    public double? ShippedPallets { get; set; }
    public double? ReceivedPallets { get; set; }
    public double? ShippedBoxes { get; set; }
    public double? ReceivedBoxes { get; set; }
    public double? ShippedThermalCovers { get; set; }
    public double? ReceivedThermalCovers { get; set; }
    public double ShippedRokhlya { get; set; }
    public double ReceivedRokhlya { get; set; }
    public double? RokhlyaDebt { get; set; }
}

public class DriverAggregate
{
    public string Name { get; set; } = "";
    public string Phone { get; set; } = "";
    public int RouteCount { get; set; }
    public double ShippedTotal { get; set; }
    public double ReceivedTotal { get; set; }
    public double ShippedPallets { get; set; }
    public double ReceivedPallets { get; set; }
    public double ShippedBoxes { get; set; }
    public double ReceivedBoxes { get; set; }
    public double ShippedThermalCovers { get; set; }
    public double ReceivedThermalCovers { get; set; }
    public double ShippedRokhlya { get; set; }
    public double ReceivedRokhlya { get; set; }
    public double? Diff { get; set; }
    public double RokhlyaDebt { get; set; }
    public List<AggregateRouteRow> Routes { get; set; } = new();
}

public class CfzAggregate
{
    public string Address { get; set; } = "";
    public string? StoreId { get; set; }
    public int RouteCount { get; set; }
    public double ShippedTotal { get; set; }
    public double ReceivedTotal { get; set; }
    public double ShippedPallets { get; set; }
    public double ReceivedPallets { get; set; }
    public double ShippedBoxes { get; set; }
    public double ReceivedBoxes { get; set; }
    public double ShippedThermalCovers { get; set; }
    public double ReceivedThermalCovers { get; set; }
    public double? Diff { get; set; }
    public List<AggregateRouteRow> Routes { get; set; } = new();
}

public class DriverPendingSummary
{
    public string Name { get; set; } = "";
    public string Phone { get; set; } = "";
    public int RouteCount { get; set; }
    public string LatestDate { get; set; } = "";
}

public class ReportAddressRow
{
    public string Address { get; set; } = "";
    public List<ReportRecord> Records { get; set; } = new();
}

public class ReportRecord
{
    public string Date { get; set; } = "";
    public double Shipped { get; set; }
    public double? Received { get; set; }
    public double ShippedBoxes { get; set; }
    public double? ReceivedBoxes { get; set; }
    public double ShippedThermalCovers { get; set; }
    public double? ReceivedThermalCovers { get; set; }
}

public class DriverRokhlyaDebtResponse
{
    public double RokhlyaDebt { get; set; }
    public DebtSince? DebtSince { get; set; }
}

public class DebtSince
{
    public string Date { get; set; } = "";
    public string? RouteNumber { get; set; }
}
