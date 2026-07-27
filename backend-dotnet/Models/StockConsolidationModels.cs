namespace BackendDotnet.Models;

// Фича «Объединение остатков» — сравнение выгрузки остатков по МХ (Excel)
// с выгрузкой задач комплектации (CSV), чтобы найти ячейки, не задействованные
// ни в одной активной задаче нужного температурного режима (их содержимое
// можно перенести в ячейки, где комплектация реально идёт). Stateless-отчёт,
// ничего не сохраняется в Postgres — см. Services/StockConsolidationService.cs.

// Одна строка выгрузки остатков (XLSX), после парсинга.
public class StockRow
{
    public string City { get; set; } = "";
    public string Rc { get; set; } = "";
    public string StorageType { get; set; } = "";
    public string Zone { get; set; } = "";
    public string Address { get; set; } = "";
    public string EoNumber { get; set; } = "";
    public string Product { get; set; } = "";
    public string Nomenclature { get; set; } = "";
    public string MfgDate { get; set; } = "";
    public string Expiry { get; set; } = "";
    public string Status { get; set; } = "";
    public decimal QtySku { get; set; }
    public decimal WeightKg { get; set; }
    public decimal VolumeL { get; set; }

    // Разбор «Адрес МХ» вида «SH-01-03-02-04» — регистр(режим)-ряд-секция-
    // номер ячейки-ярус, см. StockConsolidationService.ParseCellAddress.
    // Адреса, не подходящие под этот формат (например, ворота «G147»),
    // получают IsStandardAddress=false и пустые Row/Section/CellNumber/Tier —
    // они не участвуют в подборе получателя по ряду/ярусу.
    public bool IsStandardAddress { get; set; }
    public string Register { get; set; } = "";
    public string Row { get; set; } = "";
    public string Section { get; set; } = "";
    public string CellNumber { get; set; } = "";
    public string Tier { get; set; } = "";
}

// Результат ParseStockXlsx — строки + все реально встреченные значения
// «Тип хранения» (нужно, чтобы выявлять значения, не подошедшие ни под один
// известный код температуры, и не отбрасывать их молча).
public class StockParseResult
{
    public List<StockRow> Rows { get; set; } = new();
    public HashSet<string> DistinctStorageTypes { get; set; } = new();
}

public class StockConsolidationItemDto
{
    public string Product { get; set; } = "";
    public string EoNumber { get; set; } = "";
    public decimal QtySku { get; set; }
    public decimal WeightKg { get; set; }
    public decimal VolumeL { get; set; }
}

// Товар, уже лежащий в ячейке-получателе (до переноса) — та же форма, что и
// у StockConsolidationItemDto, чтобы фронтенд показывал «куда переносим» той
// же карточкой, что и «что переносим».
public class SuggestedTargetItemDto
{
    public string Product { get; set; } = "";
    public decimal QtySku { get; set; }
    public decimal WeightKg { get; set; }
    public decimal VolumeL { get; set; }
}

// Куда лучше перенести ВСЮ простаивающую ячейку целиком (WMS умеет
// объединять ячейку только 1-в-1, нельзя раскидать содержимое одной ячейки
// по нескольким разным — см. StockConsolidationService.AssignSuggestedTargets).
// Address == null означает, что подходящей ячейки не нашлось (см. Reason).
public class SuggestedTargetDto
{
    public string? Address { get; set; }
    public bool IsActive { get; set; }
    public bool SameProductAlreadyThere { get; set; }
    public string? Reason { get; set; }
    // Что уже лежит в ячейке-получателе (до переноса) — снэпшот из исходных
    // данных, не отражает промежуточные виртуальные подселения в рамках
    // этого же расчёта (см. AssignSuggestedTargets).
    public List<SuggestedTargetItemDto> ExistingItems { get; set; } = new();
}

// Допущение по вместимости ячейки, применённое в расчёте — единый стандарт
// на все ячейки до тех пор, пока не появится точный справочник вместимости
// по типам ячеек.
public class CellCapacityAssumptionDto
{
    public decimal VolumeL { get; set; }
    public decimal MaxWeightKg { get; set; }
    public string Note { get; set; } = "";
}

public class IdleCellDto
{
    public string Address { get; set; } = "";
    public string Zone { get; set; } = "";
    public string City { get; set; } = "";
    public string Rc { get; set; } = "";
    // Ряд/ярус, разобранные из адреса (пусто, если адрес нестандартного
    // формата — напр. ворота) — используются фронтендом для фильтра по ряду.
    public string Row { get; set; } = "";
    public string Tier { get; set; } = "";
    public int ItemsCount { get; set; }
    public decimal TotalQtySku { get; set; }
    public decimal TotalWeightKg { get; set; }
    public decimal TotalVolumeL { get; set; }
    public List<StockConsolidationItemDto> Items { get; set; } = new();
    public SuggestedTargetDto? SuggestedTarget { get; set; }
    // Альтернативный подбор получателя только среди ячеек, где тоже ровно 1
    // товар (для фильтра «Только ячейки с 1 товаром» на фронтенде) —
    // заполнено только когда ItemsCount==1, см.
    // StockConsolidationService.AssignSingleItemSuggestedTargets.
    public SuggestedTargetDto? SuggestedTargetSingleItem { get; set; }
}

public class StockConsolidationSummaryDto
{
    public int NeededProductsCount { get; set; }
    public int ActiveCellsCount { get; set; }
    public int IdleCellsCount { get; set; }
    public decimal TotalIdleQtySku { get; set; }
    public decimal TotalIdleWeightKg { get; set; }
    public decimal TotalIdleVolumeL { get; set; }
}

public class StockConsolidationTemperatureDto
{
    public string Code { get; set; } = "";
    public string ExpectedLabel { get; set; } = "";
    public List<string> UnmappedStorageTypesFound { get; set; } = new();
}

public class StockConsolidationResponse
{
    public StockConsolidationTemperatureDto Temperature { get; set; } = new();
    public StockConsolidationSummaryDto Summary { get; set; } = new();
    public List<IdleCellDto> IdleCells { get; set; } = new();
    public CellCapacityAssumptionDto CellCapacityAssumption { get; set; } = new();
}
