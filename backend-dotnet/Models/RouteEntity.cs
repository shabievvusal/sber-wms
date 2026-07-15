namespace BackendDotnet.Models;

// Маппинг на СУЩЕСТВУЮЩУЮ таблицу `routes` (создана Node, route-rk-pg.js
// init()) — колонки/типы 1-в-1, EF ничего не создаёт и не мигрирует (см.
// AppDbContext — таблица помечена как не управляемая миграциями).
public class RouteEntity
{
    public string RouteId { get; set; } = "";
    public string? RouteNumber { get; set; }
    public DateOnly? Date { get; set; }
    public Driver? Driver { get; set; }
    public Vehicle? Vehicle { get; set; }
    public string? LogisticsCompany { get; set; }
    public List<CfzAddress> CfzAddresses { get; set; } = new();
    public DateTime? ImportedAt { get; set; }
    public ShipmentInfo? Shipment { get; set; }
    public ReceivingInfo? Receiving { get; set; }
}
