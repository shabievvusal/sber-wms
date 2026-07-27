using System.Text;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// «Объединение остатков»: сравнивает выгрузку остатков по МХ (Excel) с
// выгрузкой задач комплектации (CSV) для выбранного температурного режима и
// находит ячейки (Адрес МХ), в которых не лежит ни один товар, нужный для
// невыполненных задач комплектации этого режима — их можно освобождать.
// Полностью stateless: ничего не читает и не пишет в Postgres.
public class StockConsolidationService
{
    private static readonly string[] StockHeaderColumns =
    {
        "Город РЦ", "РЦ", "Тип хранения", "Зона хранения", "Адрес МХ", "Номер ЕО", "Товар",
        "Номер номенклатуры", "Дата изготовления", "Годен до", "Статус",
        "Остатки SKU, шт", "Вес товаров в кг", "Объем товаров в литрах",
    };

    // Стандартная вместимость ячейки МХ (120×80×210 см, макс. вес 900 кг,
    // 100% заполненности — с реального экрана редактирования ячейки в WMS),
    // применяется как единый норматив ко всем ячейкам. Временное упрощение:
    // часть ячеек по факту другого размера — когда появится точный
    // справочник вместимости по типам/адресам ячеек, эти две константы
    // нужно будет заменить на подстановку из него.
    private const decimal StandardCellVolumeL = 2016m; // 120×80×210 см = 2 016 000 см³ = 2016 л
    private const decimal StandardCellMaxWeightKg = 900m;

    // «Адрес МХ» вида «SH-01-03-02-04»: регистр(режим хранения)-ряд-секция-
    // номер ячейки-ярус (порядок подтверждён пользователем). Ворота («G147»)
    // и прочие нестандартные адреса под этот формат не подходят — у них
    // просто не будет Row/Tier, и они естественно не попадут ни в подбор
    // получателя, ни как источник рекомендаций (см. AssignSuggestedTargets).
    private static readonly Regex CellAddressPattern =
        new(@"^([A-Za-zА-Яа-яЁё]+)-(\d+)-(\d+)-(\d+)-(\d+)$", RegexOptions.Compiled);

    private static void ApplyParsedAddress(StockRow row)
    {
        var m = CellAddressPattern.Match(row.Address);
        if (!m.Success) return;
        row.IsStandardAddress = true;
        row.Register = m.Groups[1].Value;
        row.Row = m.Groups[2].Value;
        row.Section = m.Groups[3].Value;
        row.CellNumber = m.Groups[4].Value;
        row.Tier = m.Groups[5].Value;
    }

    private static bool IsTier1(string tier) => int.TryParse(tier, out var n) && n == 1;

    // Снэпшот того, что лежит в каждой ячейке (до переноса), общий для обоих
    // проходов подбора получателя (обычного и «только 1 товар»).
    private static Dictionary<string, List<SuggestedTargetItemDto>> BuildExistingItemsByAddress(List<StockRow> filteredRows) =>
        filteredRows
            .GroupBy(r => r.Address)
            .ToDictionary(g => g.Key, g => g.Select(r => new SuggestedTargetItemDto
            {
                Product = r.Product,
                QtySku = r.QtySku,
                WeightKg = r.WeightKg,
                VolumeL = r.VolumeL,
            }).ToList());

    public async Task<StockConsolidationResponse> ComputeAsync(Stream stockXlsxStream, Stream tasksCsvStream, string tempCode)
    {
        if (!StockConsolidationTemperatureLabels.ByCode.TryGetValue(tempCode, out var expectedLabel))
        {
            throw new ArgumentException($"Неизвестный код температурного режима: {tempCode}");
        }

        var stock = ParseStockXlsx(stockXlsxStream);
        var neededProducts = await CollectNeededProductsAsync(tasksCsvStream, tempCode);

        // Объединение остатков рассматривается ТОЛЬКО среди ячеек 1-го яруса
        // (ярус 1 — по месту, куда физически проще переносить и откуда проще
        // комплектовать) — остальные ярусы (2, 3, 4…) не участвуют в анализе
        // вообще, ни как источник, ни как получатель. Ворота и прочие
        // нестандартные адреса (IsStandardAddress=false) заодно естественно
        // исключаются этим же фильтром.
        var filteredRows = stock.Rows
            .Where(r => string.Equals(r.StorageType.Trim(), expectedLabel, StringComparison.Ordinal))
            .Where(r => r.IsStandardAddress && IsTier1(r.Tier))
            .ToList();

        var (idleCells, activeCellsCount) = FindIdleCells(filteredRows, neededProducts);
        AssignSuggestedTargets(idleCells, filteredRows);
        AssignSingleItemSuggestedTargets(idleCells, filteredRows);

        var unmapped = stock.DistinctStorageTypes
            .Where(t => !StockConsolidationTemperatureLabels.ByCode.Values.Contains(t))
            .OrderBy(t => t, StringComparer.Ordinal)
            .ToList();

        return new StockConsolidationResponse
        {
            Temperature = new StockConsolidationTemperatureDto
            {
                Code = tempCode,
                ExpectedLabel = expectedLabel,
                UnmappedStorageTypesFound = unmapped,
            },
            Summary = new StockConsolidationSummaryDto
            {
                NeededProductsCount = neededProducts.Count,
                ActiveCellsCount = activeCellsCount,
                IdleCellsCount = idleCells.Count,
                TotalIdleQtySku = idleCells.Sum(c => c.TotalQtySku),
                TotalIdleWeightKg = idleCells.Sum(c => c.TotalWeightKg),
                TotalIdleVolumeL = idleCells.Sum(c => c.TotalVolumeL),
            },
            IdleCells = idleCells,
            CellCapacityAssumption = new CellCapacityAssumptionDto
            {
                VolumeL = StandardCellVolumeL,
                MaxWeightKg = StandardCellMaxWeightKg,
                Note = "Стандартный размер ячейки (120×80×210 см, 900 кг, 100% заполненности) применяется временно ко всем ячейкам — точные размеры по типам ячеек будут учтены позже.",
            },
        };
    }

    // Разбор XLSX остатков по МХ. 1-я строка файла — склеенная ячейка с
    // описанием применённых в WMS фильтров, не заголовок — ищем строку
    // заголовков по вхождению «Адрес МХ» среди первых нескольких строк
    // (тот же приём, что у product-weights.js:loadWeightMap в Node-версии).
    public StockParseResult ParseStockXlsx(Stream xlsxStream)
    {
        using var workbook = new XLWorkbook(xlsxStream);
        var ws = workbook.Worksheets.First();
        var rows = ws.RowsUsed().ToList();

        int headerRowIdx = -1;
        for (var i = 0; i < Math.Min(5, rows.Count); i++)
        {
            if (rows[i].CellsUsed().Any(c => c.GetString().Trim() == "Адрес МХ")) { headerRowIdx = i; break; }
        }
        if (headerRowIdx < 0)
            throw new InvalidOperationException("В файле остатков не найдена строка заголовков (нет колонки «Адрес МХ»)");

        var colByName = new Dictionary<string, int>();
        foreach (var cell in rows[headerRowIdx].CellsUsed())
        {
            var name = cell.GetString().Trim();
            if (name.Length > 0) colByName[name] = cell.Address.ColumnNumber;
        }
        foreach (var required in new[] { "Адрес МХ", "Тип хранения", "Товар" })
        {
            if (!colByName.ContainsKey(required))
                throw new InvalidOperationException($"В файле остатков не найдена колонка «{required}»");
        }

        var result = new StockParseResult();
        for (var i = headerRowIdx + 1; i < rows.Count; i++)
        {
            var row = rows[i];

            string GetStr(string col) => colByName.TryGetValue(col, out var c) ? row.Cell(c).GetString().Trim() : "";
            decimal GetNum(string col)
            {
                if (!colByName.TryGetValue(col, out var c)) return 0m;
                var cell = row.Cell(c);
                if (cell.IsEmpty()) return 0m;
                return cell.TryGetValue<double>(out var d) ? (decimal)d : 0m;
            }
            // Даты (Дата изготовления/Годен до) в Excel-ячейках без явного
            // формата отдают GetString() в "сыром" .NET-виде (09/15/2026
            // 00:00:00) — читаем как DateTime и форматируем сами, если
            // получилось; иначе (пусто/не дата) — как обычную строку.
            string GetDateStr(string col)
            {
                if (!colByName.TryGetValue(col, out var c)) return "";
                var cell = row.Cell(c);
                if (cell.IsEmpty()) return "";
                return cell.TryGetValue<DateTime>(out var dt) ? dt.ToString("dd.MM.yyyy") : cell.GetString().Trim();
            }

            var address = GetStr("Адрес МХ");
            if (address.Length == 0) continue;

            var storageType = GetStr("Тип хранения");
            if (storageType.Length > 0) result.DistinctStorageTypes.Add(storageType);

            var stockRow = new StockRow
            {
                City = GetStr("Город РЦ"),
                Rc = GetStr("РЦ"),
                StorageType = storageType,
                Zone = GetStr("Зона хранения"),
                Address = address,
                EoNumber = GetStr("Номер ЕО"),
                Product = GetStr("Товар"),
                Nomenclature = GetStr("Номер номенклатуры"),
                MfgDate = GetDateStr("Дата изготовления"),
                Expiry = GetDateStr("Годен до"),
                Status = GetStr("Статус"),
                QtySku = GetNum("Остатки SKU, шт"),
                WeightKg = GetNum("Вес товаров в кг"),
                VolumeL = GetNum("Объем товаров в литрах"),
            };
            ApplyParsedAddress(stockRow);
            result.Rows.Add(stockRow);
        }

        return result;
    }

    // Стримит CSV задач комплектации построчно (файл может быть ~90 МБ — не
    // грузим целиком в память), возвращает названия товаров из невыполненных
    // (Факт выполнения=false) задач выбранного температурного режима.
    public async Task<HashSet<string>> CollectNeededProductsAsync(Stream csvStream, string tempCode)
    {
        using var reader = new StreamReader(csvStream, Encoding.UTF8);
        var headerLine = await reader.ReadLineAsync();
        if (headerLine == null) return new HashSet<string>();

        var headers = SplitCsvLine(headerLine);
        int factIdx = Array.IndexOf(headers, "Факт выполнения");
        int tempIdx = Array.IndexOf(headers, "Температура");
        int nameIdx = Array.IndexOf(headers, "Название продукта");
        if (factIdx < 0 || tempIdx < 0 || nameIdx < 0)
            throw new InvalidOperationException("В CSV задач не найдены ожидаемые колонки (Факт выполнения / Температура / Название продукта)");

        var needed = new HashSet<string>();
        string? line;
        while ((line = await reader.ReadLineAsync()) != null)
        {
            if (line.Length == 0) continue;
            var parts = SplitCsvLine(line);
            var maxIdx = Math.Max(factIdx, Math.Max(tempIdx, nameIdx));
            if (parts.Length <= maxIdx) continue;
            if (!string.Equals(parts[factIdx].Trim(), "false", StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(parts[tempIdx].Trim(), tempCode, StringComparison.Ordinal)) continue;
            var name = parts[nameIdx].Trim();
            if (name.Length > 0) needed.Add(name);
        }
        return needed;
    }

    // Группировка по «Адрес МХ» → ячейка «простаивает», если ни один её товар
    // (точное совпадение по названию, после Trim) не входит в neededProducts.
    // rows уже отфильтрованы по нужному температурному режиму вызывающим
    // кодом (ComputeAsync) — здесь фильтрации по «Тип хранения» больше нет.
    public (List<IdleCellDto> IdleCells, int ActiveCellsCount) FindIdleCells(
        List<StockRow> rows, HashSet<string> neededProducts)
    {
        var groups = rows.GroupBy(r => r.Address);

        var idleCells = new List<IdleCellDto>();
        var activeCellsCount = 0;

        foreach (var group in groups)
        {
            var cellRows = group.ToList();
            var isActive = cellRows.Any(r => neededProducts.Contains(r.Product.Trim()));
            if (isActive) { activeCellsCount++; continue; }

            var items = cellRows.Select(r => new StockConsolidationItemDto
            {
                Product = r.Product,
                EoNumber = r.EoNumber,
                QtySku = r.QtySku,
                WeightKg = r.WeightKg,
                VolumeL = r.VolumeL,
            }).ToList();

            var first = cellRows[0];
            idleCells.Add(new IdleCellDto
            {
                Address = group.Key,
                Zone = first.Zone,
                City = first.City,
                Rc = first.Rc,
                Row = first.Row,
                Tier = first.Tier,
                ItemsCount = items.Count,
                TotalQtySku = items.Sum(i => i.QtySku),
                TotalWeightKg = items.Sum(i => i.WeightKg),
                TotalVolumeL = items.Sum(i => i.VolumeL),
                Items = items,
            });
        }

        return (idleCells, activeCellsCount);
    }

    // Для каждой простаивающей ячейки ЦЕЛИКОМ подбирает ячейку-получателя:
    // WMS умеет объединять ячейку только 1-в-1 (одну на одну) — нельзя
    // раскидать содержимое одной ячейки по нескольким разным получателям,
    // поэтому решение принимается на уровне всей ячейки (по сумме объёма/
    // веса всех её товаров), а не по каждому товару отдельно. Получатель:
    // любая другая ячейка (активная или простаивающая — не важно, важно
    // освободить именно исходную), В ТОМ ЖЕ РЯДУ (Row, разобран из адреса).
    // Вызывающий код (ComputeAsync) уже отфильтровал filteredRows только до
    // ячеек 1-го яруса (IsStandardAddress && Tier==1) — другие ярусы, ворота
    // и прочие нестандартные адреса в анализ вообще не попадают, поэтому
    // здесь речь идёт только про совпадение ряда (проверка на ярус внутри —
    // защитная, по факту уже всегда истинна на входных данных).
    // С достаточным остатком вместимости по объёму И весу (стандартный
    // норматив ячейки, см. константы выше) на ВСЮ ячейку сразу. Сначала
    // пробуем получателя, где уже лежит хотя бы один из переносимых товаров
    // (консолидация одного SKU в одном месте), иначе — любого подходящего по
    // объёму/весу (best-fit: с наименьшим остатком свободного места после
    // подселения — чтобы не размазывать остатки по ячейкам). Более крупные
    // (по суммарному объёму) простаивающие ячейки распределяются первыми
    // (best-fit decreasing), чтобы не занять мелкой ячейкой единственного
    // получателя, куда влезла бы более крупная. Виртуальная занятость
    // ячеек-получателей накапливается по ходу распределения — один и тот же
    // адрес не будет рекомендован для перегруза несколькими ячейками сразу.
    public void AssignSuggestedTargets(List<IdleCellDto> idleCells, List<StockRow> filteredRows)
    {
        var cellVolume = new Dictionary<string, decimal>();
        var cellWeight = new Dictionary<string, decimal>();
        var rowToTier1Addresses = new Dictionary<string, HashSet<string>>();

        foreach (var r in filteredRows)
        {
            cellVolume[r.Address] = cellVolume.GetValueOrDefault(r.Address) + r.VolumeL;
            cellWeight[r.Address] = cellWeight.GetValueOrDefault(r.Address) + r.WeightKg;

            if (!r.IsStandardAddress || !IsTier1(r.Tier)) continue; // получателем может быть только ярус 1

            if (!rowToTier1Addresses.TryGetValue(r.Row, out var addrSet))
                rowToTier1Addresses[r.Row] = addrSet = new HashSet<string>();
            addrSet.Add(r.Address);
        }

        var idleAddresses = idleCells.Select(c => c.Address).ToHashSet();
        var rowByAddress = filteredRows
            .Where(r => r.IsStandardAddress)
            .GroupBy(r => r.Address)
            .ToDictionary(g => g.Key, g => g.First().Row);

        // Снэпшот того, что уже лежит в каждой ячейке (до переноса) — чтобы
        // показать в «Куда перенести» содержимое ячейки-получателя, и заодно
        // проверять «есть ли там уже хотя бы один из наших товаров». Строится
        // один раз из исходных данных, а не из cellVolume/cellWeight, которые
        // дальше по ходу расчёта накапливают виртуальные подселения —
        // в ExistingItems должно быть только то, что там реально лежит сейчас.
        var existingItemsByAddress = BuildExistingItemsByAddress(filteredRows);

        var orderedCells = idleCells.OrderByDescending(c => c.TotalVolumeL).ToList();

        foreach (var cell in orderedCells)
        {
            if (!rowByAddress.TryGetValue(cell.Address, out var sourceRow))
            {
                cell.SuggestedTarget = new SuggestedTargetDto { Reason = "Не удалось разобрать адрес ячейки (ряд/ярус)" };
                continue;
            }
            if (!rowToTier1Addresses.TryGetValue(sourceRow, out var rowAddresses))
            {
                cell.SuggestedTarget = new SuggestedTargetDto { Reason = "В этом ряду нет ячеек 1-го яруса" };
                continue;
            }

            var totalVolume = cell.TotalVolumeL;
            var totalWeight = cell.TotalWeightKg;

            bool Fits(string addr) =>
                addr != cell.Address &&
                cellVolume.GetValueOrDefault(addr) + totalVolume <= StandardCellVolumeL &&
                cellWeight.GetValueOrDefault(addr) + totalWeight <= StandardCellMaxWeightKg;

            decimal LeftoverAfterFit(string addr) =>
                StandardCellVolumeL - (cellVolume.GetValueOrDefault(addr) + totalVolume);

            var cellProducts = cell.Items.Select(i => i.Product.Trim()).ToHashSet();
            bool HasAnySameProduct(string addr) =>
                existingItemsByAddress.TryGetValue(addr, out var existing) &&
                existing.Any(e => cellProducts.Contains(e.Product.Trim()));

            string? chosen = rowAddresses.Where(Fits).Where(HasAnySameProduct).OrderBy(LeftoverAfterFit).FirstOrDefault();
            var sameProduct = chosen != null;
            chosen ??= rowAddresses.Where(Fits).OrderBy(LeftoverAfterFit).FirstOrDefault();

            if (chosen == null)
            {
                cell.SuggestedTarget = new SuggestedTargetDto
                {
                    Reason = "Нет ячейки 1-го яруса в этом ряду, куда поместилась бы вся ячейка целиком (WMS объединяет только 1-в-1)",
                };
                continue;
            }

            cellVolume[chosen] = cellVolume.GetValueOrDefault(chosen) + totalVolume;
            cellWeight[chosen] = cellWeight.GetValueOrDefault(chosen) + totalWeight;
            cell.SuggestedTarget = new SuggestedTargetDto
            {
                Address = chosen,
                IsActive = !idleAddresses.Contains(chosen),
                SameProductAlreadyThere = sameProduct,
                ExistingItems = existingItemsByAddress.GetValueOrDefault(chosen, new()),
            };
        }
    }

    // Отдельный, независимый подбор получателя для фильтра фронтенда «Только
    // ячейки с 1 товаром» — там пользователю нужны пары «в источнике 1
    // товар → в получателе тоже 1 товар» (не 1 товар, переезжающий в ячейку,
    // где уже 3 других), поэтому обычного AssignSuggestedTargets (который
    // разрешает получателем любую ячейку вне зависимости от числа её
    // позиций) недостаточно — считаем результат в отдельное поле
    // SuggestedTargetSingleItem, никак не завязанное на основной подбор
    // (своё виртуальное состояние занятости). Заполняется только для
    // простаивающих ячеек с ItemsCount==1 — для остальных не имеет смысла
    // (тот фильтр их и так скрывает).
    public void AssignSingleItemSuggestedTargets(List<IdleCellDto> idleCells, List<StockRow> filteredRows)
    {
        var itemCountByAddress = filteredRows.GroupBy(r => r.Address).ToDictionary(g => g.Key, g => g.Count());

        var cellVolume = new Dictionary<string, decimal>();
        var cellWeight = new Dictionary<string, decimal>();
        var rowToSingleItemAddresses = new Dictionary<string, HashSet<string>>();

        foreach (var r in filteredRows)
        {
            cellVolume[r.Address] = cellVolume.GetValueOrDefault(r.Address) + r.VolumeL;
            cellWeight[r.Address] = cellWeight.GetValueOrDefault(r.Address) + r.WeightKg;

            if (!r.IsStandardAddress || !IsTier1(r.Tier)) continue;
            if (itemCountByAddress.GetValueOrDefault(r.Address) != 1) continue; // получатель тоже должен быть с ровно 1 товаром

            if (!rowToSingleItemAddresses.TryGetValue(r.Row, out var addrSet))
                rowToSingleItemAddresses[r.Row] = addrSet = new HashSet<string>();
            addrSet.Add(r.Address);
        }

        var idleAddresses = idleCells.Select(c => c.Address).ToHashSet();
        var rowByAddress = filteredRows
            .Where(r => r.IsStandardAddress)
            .GroupBy(r => r.Address)
            .ToDictionary(g => g.Key, g => g.First().Row);
        var existingItemsByAddress = BuildExistingItemsByAddress(filteredRows);

        var singleItemCells = idleCells.Where(c => c.ItemsCount == 1).OrderByDescending(c => c.TotalVolumeL).ToList();

        foreach (var cell in singleItemCells)
        {
            if (!rowByAddress.TryGetValue(cell.Address, out var sourceRow) ||
                !rowToSingleItemAddresses.TryGetValue(sourceRow, out var candidates))
            {
                cell.SuggestedTargetSingleItem = new SuggestedTargetDto { Reason = "Нет других ячеек с 1 товаром в этом ряду" };
                continue;
            }

            var totalVolume = cell.TotalVolumeL;
            var totalWeight = cell.TotalWeightKg;
            var product = cell.Items[0].Product.Trim();

            bool Fits(string addr) =>
                addr != cell.Address &&
                cellVolume.GetValueOrDefault(addr) + totalVolume <= StandardCellVolumeL &&
                cellWeight.GetValueOrDefault(addr) + totalWeight <= StandardCellMaxWeightKg;

            decimal LeftoverAfterFit(string addr) =>
                StandardCellVolumeL - (cellVolume.GetValueOrDefault(addr) + totalVolume);

            bool HasSameProduct(string addr) =>
                existingItemsByAddress.TryGetValue(addr, out var existing) &&
                existing.Any(e => e.Product.Trim() == product);

            string? chosen = candidates.Where(Fits).Where(HasSameProduct).OrderBy(LeftoverAfterFit).FirstOrDefault();
            var sameProduct = chosen != null;
            chosen ??= candidates.Where(Fits).OrderBy(LeftoverAfterFit).FirstOrDefault();

            if (chosen == null)
            {
                cell.SuggestedTargetSingleItem = new SuggestedTargetDto
                {
                    Reason = "Нет ячейки с 1 товаром в этом ряду, куда поместилась бы вся ячейка целиком",
                };
                continue;
            }

            cellVolume[chosen] = cellVolume.GetValueOrDefault(chosen) + totalVolume;
            cellWeight[chosen] = cellWeight.GetValueOrDefault(chosen) + totalWeight;
            cell.SuggestedTargetSingleItem = new SuggestedTargetDto
            {
                Address = chosen,
                IsActive = !idleAddresses.Contains(chosen),
                SameProductAlreadyThere = sameProduct,
                ExistingItems = existingItemsByAddress.GetValueOrDefault(chosen, new()),
            };
        }
    }

    // Quote-aware сплит строки CSV по `;`. В реальных примерах выгрузки
    // кавычки встречаются только вокруг числовых полей с запятой как
    // десятичным разделителем ("2,0") и никогда не содержат `;` внутри —
    // но дёшево подстраховаться на случай, если экспорт WMS когда-нибудь
    // начнёт квотить текстовые поля с `;` внутри (адреса, названия).
    public static string[] SplitCsvLine(string line)
    {
        var result = new List<string>();
        var sb = new StringBuilder();
        var inQuotes = false;

        for (var i = 0; i < line.Length; i++)
        {
            var ch = line[i];
            if (inQuotes)
            {
                if (ch == '"')
                {
                    if (i + 1 < line.Length && line[i + 1] == '"') { sb.Append('"'); i++; }
                    else inQuotes = false;
                }
                else sb.Append(ch);
            }
            else
            {
                if (ch == '"') inQuotes = true;
                else if (ch == ';') { result.Add(sb.ToString()); sb.Clear(); }
                else sb.Append(ch);
            }
        }
        result.Add(sb.ToString());
        return result.ToArray();
    }
}
