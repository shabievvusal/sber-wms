namespace BackendDotnet.Models;

// Соответствие кодов температурного режима (как в CSV задач комплектации,
// колонка «Температура»: ORDINARY/MEDIUM_COLD/LOW_COLD) русским подписям
// типа хранения (как в XLSX остатков по МХ, колонка «Тип хранения») —
// подтверждено пользователем (2026-07-27), больше не заглушки.
// Единственное место в проекте, где живут эти русские подписи.
public static class StockConsolidationTemperatureLabels
{
    public static readonly Dictionary<string, string> ByCode = new()
    {
        ["ORDINARY"] = "Сухой",
        ["MEDIUM_COLD"] = "Средний холод",
        ["LOW_COLD"] = "Низкий холод",
    };
}
