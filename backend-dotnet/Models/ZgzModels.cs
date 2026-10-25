namespace BackendDotnet.Models;

// Переводы ЕО в ЗГЗ (stocks/changes, MOVE_TO_READY_ORDERS_ZONE) — для
// страницы «Поиск потеряшек»: найденную ЕО без опознания подбирают по
// штрихкодам товаров внутри. Строка — товар в ЕО (merge_key = id строки WMS).
public class WmsZgzMoveEntity
{
    public long Id { get; set; }
    public DateOnly Date { get; set; }
    public short Hour { get; set; }
    public string MergeKey { get; set; } = "";
    public string Hu { get; set; } = "";
    public string SourceCell { get; set; } = "";
    public string TargetCell { get; set; } = "";
    public string ProductId { get; set; } = "";
    public string ProductName { get; set; } = "";
    public string NomenclatureCode { get; set; } = "";
    // штрихкоды товара через «|»
    public string Barcodes { get; set; } = "";
    public decimal Quantity { get; set; }
    public string ExecutorId { get; set; } = "";
    public string Executor { get; set; } = "";
    public DateTime? CompletedAt { get; set; }
}

// POST /api/zgz/save — облегчённые строки из браузера (fetchZgzMoves).
public class ZgzSaveRequest
{
    public List<ZgzRow>? Items { get; set; }
}

public class ZgzRow
{
    public string? Id { get; set; }
    public string? Hu { get; set; }
    public string? SourceCell { get; set; }
    public string? TargetCell { get; set; }
    public string? ProductId { get; set; }
    public string? Name { get; set; }
    public string? Code { get; set; }
    public List<string>? Barcodes { get; set; }
    public decimal? Qty { get; set; }
    public string? ExecutorId { get; set; }
    public string? Executor { get; set; }
    public DateTime? CompletedAt { get; set; }
}

public class ZgzDeleteRequest
{
    // пусто — удалить всё (по складу)
    public string? DateFrom { get; set; }
    public string? DateTo { get; set; }
}
