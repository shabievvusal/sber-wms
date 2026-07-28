namespace BackendDotnet.Models;

// Порт storage.js (Фаза 3) — 4 домена: ops (КДК/хранение), placement
// (размещение), receiving (приёмка), remains (остатки/консолидация).
// Все 4 таблицы уже существуют в Postgres (созданы бэкфилл-скриптом
// migrate-storage-json-to-pg.js, тем же приёмом, что и остальные *-pg.js
// модули) — dotnet только читает/пишет по готовой схеме.

public class ResponsibleUser
{
    public string Id { get; set; } = "";
    public string FirstName { get; set; } = "";
    public string LastName { get; set; } = "";
    public string MiddleName { get; set; } = "";
}

// POST /api/date/:date/storage — агрегат размещения, вводимый вручную с
// фронта (day/night). storage.js:getStorageForDate (чтение обратно) —
// подтверждённый мёртвый код (нет вызывающих), сохранён здесь только для
// полноты записи — таблица есть, потому что сам write-эндпоинт в объёме
// переноса.
public class WmsStorageAggEntity
{
    public DateOnly Date { get; set; }
    public string Shift { get; set; } = "";
    public decimal TotalStorageCount { get; set; }
    public Dictionary<string, decimal> StorageByHour { get; set; } = new();
    public decimal TotalWeightGrams { get; set; }
    public Dictionary<string, decimal> WeightByEmployee { get; set; } = new();
}

// hourlyByEmployee типизирован отдельно (в отличие от остальных полей
// сводки, оставленных как object/Dictionary для прямой JSON-сериализации),
// потому что employee-rates (GetEmployeeRatesAsync) читает его обратно
// (row.byHour/row.byZone/row.total) — держать как object было бы нельзя
// без даункаста/dynamic на каждый доступ.
public class HourlyByEmployeeResult
{
    public List<int> Hours { get; set; } = new();
    public List<Dictionary<string, object?>> Rows { get; set; } = new();
}

// Возврат GetDateSummaryAsync/BuildSummaryFromItems — аналог того, что
// возвращает buildSummaryFromItems() в storage.js. Большинство полей —
// object/Dictionary (форма динамическая, как и в JS), только
// HourlyByEmployee типизирован (см. комментарий выше).
public class DateSummaryResult
{
    public int TotalOps { get; set; }
    public decimal TotalQty { get; set; }
    public object Executors { get; set; } = new List<object>();
    public object Hourly { get; set; } = new List<object>();
    public DateTime? FirstAt { get; set; }
    public DateTime? LastAt { get; set; }
    public object CompanySummary { get; set; } = new { rows = new List<object>(), hoursDisplay = new List<int>() };
    public HourlyByEmployeeResult HourlyByEmployee { get; set; } = new();
    public object IdlesByEmployee { get; set; } = new Dictionary<string, object>();
    public decimal TotalWeightStorageGrams { get; set; }
    public decimal TotalWeightKdkGrams { get; set; }
    public decimal TotalWeightGrams { get; set; }
    public object WeightByEmployee { get; set; } = new Dictionary<string, object>();
    public object WeightByCompany { get; set; } = new Dictionary<string, object>();
    public object MissingWeightNames { get; set; } = new List<string>();
    public object MissingWeightItems { get; set; } = new List<object>();
}

// ─── Ops (wms_ops) — "light item", аналог toLightItem() в storage.js ──────

public class WmsOpEntity
{
    public long Id { get; set; }
    public DateOnly Date { get; set; }
    public short Hour { get; set; }
    public string MergeKey { get; set; } = "";
    public string ItemId { get; set; } = "";
    public string Type { get; set; } = "";
    public string OperationType { get; set; } = "";
    public string ProductName { get; set; } = "";
    public string NomenclatureCode { get; set; } = "";
    public string Barcodes { get; set; } = "";
    public string ProductionDate { get; set; } = "";
    public string BestBeforeDate { get; set; } = "";
    public string SourceBarcode { get; set; } = "";
    public string Cell { get; set; } = "";
    public string TargetBarcode { get; set; } = "";
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public string Executor { get; set; } = "";
    public string ExecutorId { get; set; } = "";
    public decimal? SrcOld { get; set; }
    public decimal? SrcNew { get; set; }
    public decimal? TgtOld { get; set; }
    public decimal? TgtNew { get; set; }
    public decimal? Quantity { get; set; }
}

// ─── Placement (wms_placement) ─────────────────────────────────────────────

public class WmsPlacementEntity
{
    public long Id { get; set; }
    public DateOnly Date { get; set; }
    public short Hour { get; set; }
    public string MergeKey { get; set; } = "";
    public string ItemId { get; set; } = "";
    public string Status { get; set; } = "";
    public string HandlingUnitBarcode { get; set; } = "";
    public string SourceCellAddress { get; set; } = "";
    public string TargetCellAddress { get; set; } = "";
    public List<string> TargetCellsAddresses { get; set; } = new();
    public string SourceZoneId { get; set; } = "";
    public string SourceZoneName { get; set; } = "";
    public ResponsibleUser ResponsibleUser { get; set; } = new();
    public string ExecutorId { get; set; } = "";
    public string Executor { get; set; } = "";
    public DateTime? CreatedAt { get; set; }
    public string Issue { get; set; } = "";
    public string Condition { get; set; } = "";
    public string TemperatureMode { get; set; } = "";
    public decimal SkuCount { get; set; }
}

// ─── Receiving (wms_receiving) ─────────────────────────────────────────────

public class WmsReceivingEntity
{
    public long Id { get; set; }
    public DateOnly Date { get; set; }
    public short Hour { get; set; }
    public string MergeKey { get; set; } = "";
    public string ItemId { get; set; } = "";
    public string Status { get; set; } = "";
    public string Type { get; set; } = "";
    public string TaskNumber { get; set; } = "";
    public string OrderNumber { get; set; } = "";
    public string SupplierName { get; set; } = "";
    public DateTime? StartedAt { get; set; }
    public ResponsibleUser ResponsibleUser { get; set; } = new();
    public string ExecutorId { get; set; } = "";
    public string Executor { get; set; } = "";
    public DateTime? CompletedAt { get; set; }
    public decimal VolumeInMilliliters { get; set; }
    public decimal WeightInGrams { get; set; }
    public decimal EoCount { get; set; }
}

// ─── Remains (wms_remains) ─────────────────────────────────────────────────

public class WmsRemainsEntity
{
    public long Id { get; set; }
    public DateOnly Date { get; set; }
    public short Hour { get; set; }
    public string MergeKey { get; set; } = "";
    public string ItemId { get; set; } = "";
    public string Status { get; set; } = "";
    public string TaskType { get; set; } = "";
    public string SourceCellAddress { get; set; } = "";
    public string SourceHandlingUnitBarcode { get; set; } = "";
    public string TargetCellAddress { get; set; } = "";
    public string TargetHandlingUnitBarcode { get; set; } = "";
    public List<System.Text.Json.JsonElement> ConsolidationItems { get; set; } = new();
    public ResponsibleUser ResponsibleUser { get; set; } = new();
    public string ExecutorId { get; set; } = "";
    public string Executor { get; set; } = "";
    public DateTime? CreatedAt { get; set; }
}

// ─── product_weights ────────────────────────────────────────────────────────

public class ProductWeightEntity
{
    public string Article { get; set; } = "";
    public decimal Grams { get; set; }
}

// ─── Request DTOs (тела запросов — те же поля, что во входном JSON у Node) ─

public class SaveStorageRequest
{
    public string? Shift { get; set; }
    public decimal? TotalStorageCount { get; set; }
    public Dictionary<string, decimal>? StorageByHour { get; set; }
    public decimal? TotalWeightGrams { get; set; }
    public Dictionary<string, decimal>? WeightByEmployee { get; set; }
}

// Удаление/подсчёт данных за смену во всех 4 доменах статистики сразу
// (Настройки → Система, только admin/developer) — см.
// StatsService.CountShiftDataAsync/DeleteShiftDataAsync.
public class ShiftDataRequest
{
    public string Date { get; set; } = "";
    public string Shift { get; set; } = "";
}

public class ShiftDataCounts
{
    public int Ops { get; set; }
    public int Placement { get; set; }
    public int Receiving { get; set; }
    public int Remains { get; set; }
    public int Total => Ops + Placement + Receiving + Remains;
}

public class OpsIngestRequest
{
    public System.Text.Json.JsonElement? Value { get; set; }
    public List<System.Text.Json.JsonElement>? Items { get; set; }
}

public class PlacementSaveRequest
{
    public List<System.Text.Json.JsonElement>? Items { get; set; }
}

public class ReceivingSaveRequest
{
    public List<System.Text.Json.JsonElement>? Items { get; set; }
}

public class RemainsSaveRequest
{
    public List<System.Text.Json.JsonElement>? Items { get; set; }
}
