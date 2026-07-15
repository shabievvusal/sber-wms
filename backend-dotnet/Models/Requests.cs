namespace BackendDotnet.Models;

// Тела запросов — те же поля, что и в req.body у соответствующих роутов
// server.js (submitShipment/submitReceiving/updateShipment/updateReceiving/
// updateRouteDriver).

public class ItemRequest
{
    public string? Address { get; set; }
    public double Rk { get; set; }
    public double? Pallets { get; set; }
    public double? Boxes { get; set; }
    public double? ThermalCovers { get; set; }
}

public class ShipmentRequest
{
    public string? By { get; set; }
    public string? Gate { get; set; }
    public double? TempBefore { get; set; }
    public double? TempAfter { get; set; }
    public double? Rokhlya { get; set; }
    public List<ItemRequest>? Items { get; set; }
    public List<string>? Photos { get; set; }
}

public class ReceivingRequest
{
    public string? By { get; set; }
    public string? Gate { get; set; }
    public double? Rokhlya { get; set; }
    public List<ItemRequest>? Items { get; set; }
    public List<string>? Photos { get; set; }
}

public class DriverUpdateRequest
{
    public string? Name { get; set; }
    public string? Phone { get; set; }
}

public class ImportBulkRequest
{
    public List<System.Text.Json.JsonElement>? Routes { get; set; }
}

public class DeleteBulkRequest
{
    public List<string>? Ids { get; set; }
}
