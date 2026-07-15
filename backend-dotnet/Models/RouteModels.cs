namespace BackendDotnet.Models;

// Вложенные JSONB-объекты — те же поля, что и в route-rk-pg.js (rowToRoute/
// normalizeItem/parseWmsRoute), сериализуются camelCase (см. Json.Options.cs),
// чтобы JSON-контракт был идентичен Node.

public class Driver
{
    public string? Name { get; set; }
    public string? Phone { get; set; }
}

public class Vehicle
{
    public string? Number { get; set; }
    public string? Model { get; set; }
}

public class Eo
{
    public string? Barcode { get; set; }
    public double? Weight { get; set; }
}

public class CfzAddress
{
    public string Address { get; set; } = "";
    public string? StoreId { get; set; }
    public List<Eo> Eos { get; set; } = new();
    public List<Eo> RemovedEos { get; set; } = new();
}

public class Item
{
    public string Address { get; set; } = "";
    public double Rk { get; set; }
    public double Pallets { get; set; }
    public double Boxes { get; set; }
    public double ThermalCovers { get; set; }
}

public class ShipmentInfo
{
    public string? By { get; set; }
    public string? Gate { get; set; }
    public double? TempBefore { get; set; }
    public double? TempAfter { get; set; }
    public double? Rokhlya { get; set; }
    public string? At { get; set; }
    public bool Confirmed { get; set; }
    public string? ConfirmedAt { get; set; }
    public string? ConfirmedBy { get; set; }
    public string? UpdatedAt { get; set; }
    public List<string> Photos { get; set; } = new();
    public List<Item> Items { get; set; } = new();
}

public class ReceivingInfo
{
    public string? By { get; set; }
    public string? Gate { get; set; }
    public double? Rokhlya { get; set; }
    public string? At { get; set; }
    public bool Confirmed { get; set; }
    public string? ConfirmedAt { get; set; }
    public string? ConfirmedBy { get; set; }
    public string? UpdatedAt { get; set; }
    public List<string> Photos { get; set; } = new();
    public List<Item> Items { get; set; } = new();
}
