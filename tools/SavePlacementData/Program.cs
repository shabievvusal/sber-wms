using System.Text.Json;
using System.Text.Json.Nodes;

// Порт backend/storage.js (normalizePlacementItem/placementMoscowDateHour/
// loadPlacementHour/savePlacementItems) — 1-в-1 та же merge-семантика, но на
// C#, чтобы Node перестал сам считать мёрдж (см. PLAN.md, «Убрать
// JS-дублирование в дуал-райт мосте»). Вызывается так же, как уже работающий
// tools/SaveFetchedData — --input/--data-dir, JSON-результат на stdout.

var jsonOpts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

var inputPath = GetArg("--input", "");
var dataDir = GetArg("--data-dir", "backend/data");
if (string.IsNullOrWhiteSpace(inputPath) || !File.Exists(inputPath))
{
    Console.Error.WriteLine("Missing --input");
    Environment.Exit(2);
}

Directory.CreateDirectory(dataDir);

var addedTotal = 0;
var skippedTotal = 0;
var byShift = new Dictionary<string, bool>(StringComparer.Ordinal);

using (var fs = File.OpenRead(inputPath))
using (var doc = JsonDocument.Parse(fs))
{
    if (!TryGetItems(doc.RootElement, out var items))
    {
        WriteResult(0, 0, byShift);
        return;
    }

    // Проход 1 — нормализовать каждый элемент (та же форма, что даёт
    // normalizePlacementItem) и сгруппировать по московским (date,hour),
    // вычисленным через primary-таймстамп (createdAt ?? completedAt ??
    // updatedAt) — 1-в-1 placementMoscowDateHour, БЕЗ отката на предыдущую
    // дату для часов 0-8 (это отдельное правило, используемое только
    // старым ops-путём в SaveFetchedData, здесь не применяется).
    var bySlot = new Dictionary<(string Date, int Hour), List<PlacementItem>>();
    foreach (var raw in items.EnumerateArray())
    {
        if (raw.ValueKind != JsonValueKind.Object) continue;
        var item = NormalizePlacementItem(raw);
        if (string.IsNullOrEmpty(item.CreatedAt)) continue;
        var slot = MoscowDateHour(item.CreatedAt);
        if (slot == null) continue;
        var key = (slot.Value.DateStr, slot.Value.Hour);
        if (!bySlot.TryGetValue(key, out var list))
        {
            list = new List<PlacementItem>();
            bySlot[key] = list;
        }
        list.Add(item);
    }

    foreach (var kv in bySlot)
    {
        var dateStr = kv.Key.Date;
        var hour = kv.Key.Hour;
        var dir = Path.Combine(dataDir, dateStr, "placement");
        Directory.CreateDirectory(dir);
        var map = LoadHour(dir, hour, jsonOpts);

        foreach (var item in kv.Value)
        {
            var key = MergeKey(item);
            if (string.IsNullOrEmpty(key)) { skippedTotal++; continue; }
            if (map.TryGetValue(key, out var existing))
            {
                map[key] = item with
                {
                    ResponsibleUser = item.ResponsibleUser,
                    ExecutorId = item.ExecutorId != "" ? item.ExecutorId : existing.ExecutorId,
                    Executor = item.Executor != "" ? item.Executor : existing.Executor,
                    TargetCellsAddresses = item.TargetCellsAddresses.Count > 0 ? item.TargetCellsAddresses : existing.TargetCellsAddresses,
                    SkuCount = item.SkuCount != 0 ? item.SkuCount : existing.SkuCount,
                };
                skippedTotal++;
                continue;
            }
            map[key] = item;
            addedTotal++;
        }

        SaveHour(dir, hour, map.Values, jsonOpts);
        byShift[$"{dateStr}_{(hour >= 9 && hour < 21 ? "day" : "night")}"] = true;
    }
}

WriteResult(addedTotal, skippedTotal, byShift);

string GetArg(string key, string defaultValue)
{
    for (var i = 0; i < args.Length; i++)
    {
        if (!args[i].Equals(key, StringComparison.OrdinalIgnoreCase)) continue;
        if (i + 1 < args.Length) return args[i + 1];
    }
    return defaultValue;
}

static bool TryGetItems(JsonElement root, out JsonElement items)
{
    if (root.ValueKind == JsonValueKind.Array) { items = root; return true; }
    if (root.ValueKind == JsonValueKind.Object)
    {
        if (root.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.Object
            && value.TryGetProperty("items", out var valueItems) && valueItems.ValueKind == JsonValueKind.Array)
        {
            items = valueItems;
            return true;
        }
        if (root.TryGetProperty("items", out var itemsProp) && itemsProp.ValueKind == JsonValueKind.Array)
        {
            items = itemsProp;
            return true;
        }
    }
    items = default;
    return false;
}

static string GetString(JsonElement obj, string name)
    => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

static string? GetStringOrNull(JsonElement obj, string name)
    => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

static JsonElement GetObj(JsonElement obj, string name)
    => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : default;

static decimal GetNumber(JsonElement obj, string name)
{
    if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDecimal(out var d))
        return d;
    return 0m;
}

static JsonArray GetJsonArray(JsonElement obj, string name)
{
    if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array)
        return (JsonArray)JsonNode.Parse(v.GetRawText())!;
    return new JsonArray();
}

static string NormalizeUserName(string last, string first, string middle)
{
    var parts = new[] { last, first, middle }.Where(s => !string.IsNullOrWhiteSpace(s));
    return string.Join(" ", parts).Trim();
}

static PlacementItem NormalizePlacementItem(JsonElement raw)
{
    var createdAt = GetStringOrNull(raw, "createdAt") ?? GetStringOrNull(raw, "completedAt") ?? GetStringOrNull(raw, "updatedAt");
    var ru = GetObj(raw, "responsibleUser");
    var responsibleUser = new ResponsibleUserLite
    {
        Id = GetString(ru, "id"),
        FirstName = GetString(ru, "firstName"),
        LastName = GetString(ru, "lastName"),
        MiddleName = GetString(ru, "middleName"),
    };
    var nameJoined = NormalizeUserName(responsibleUser.LastName, responsibleUser.FirstName, responsibleUser.MiddleName);
    return new PlacementItem
    {
        Id = GetString(raw, "id").Trim(),
        Status = GetString(raw, "status"),
        HandlingUnitBarcode = GetString(raw, "handlingUnitBarcode"),
        SourceCellAddress = GetString(raw, "sourceCellAddress"),
        TargetCellAddress = GetString(raw, "targetCellAddress"),
        TargetCellsAddresses = GetJsonArray(raw, "targetCellsAddresses"),
        SourceZoneId = GetString(raw, "sourceZoneId"),
        SourceZoneName = GetString(raw, "sourceZoneName"),
        ResponsibleUser = responsibleUser,
        ExecutorId = responsibleUser.Id,
        Executor = !string.IsNullOrEmpty(nameJoined) ? nameJoined : responsibleUser.Id,
        CreatedAt = createdAt,
        CompletedAt = createdAt,
        Issue = GetString(raw, "issue"),
        Condition = GetString(raw, "condition"),
        TemperatureMode = GetString(raw, "temperatureMode"),
        SkuCount = GetNumber(raw, "skuCount"),
    };
}

static string MergeKey(PlacementItem item)
{
    if (item.Id != "") return item.Id;
    if (item.HandlingUnitBarcode != "") return item.HandlingUnitBarcode;
    return $"{item.CreatedAt}|{item.ExecutorId}|{item.TargetCellAddress}";
}

static (string DateStr, int Hour)? MoscowDateHour(string? ts)
{
    if (string.IsNullOrEmpty(ts)) return null;
    if (!DateTime.TryParse(ts, System.Globalization.CultureInfo.InvariantCulture,
        System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var d))
        return null;
    var moscow = d.AddHours(3);
    return (moscow.ToString("yyyy-MM-dd"), moscow.Hour);
}

static Dictionary<string, PlacementItem> LoadHour(string dir, int hour, JsonSerializerOptions jsonOpts)
{
    var map = new Dictionary<string, PlacementItem>(StringComparer.Ordinal);
    var fp = Path.Combine(dir, hour.ToString("D2") + ".json");
    if (!File.Exists(fp)) return map;
    try
    {
        using var fs = File.OpenRead(fp);
        using var doc = JsonDocument.Parse(fs);
        if (!doc.RootElement.TryGetProperty("items", out var itemsEl)) return map;

        List<PlacementItem>? list = null;
        if (itemsEl.ValueKind == JsonValueKind.Array)
        {
            list = JsonSerializer.Deserialize<List<PlacementItem>>(itemsEl.GetRawText(), jsonOpts);
        }
        else if (itemsEl.ValueKind == JsonValueKind.Object)
        {
            var dict = JsonSerializer.Deserialize<Dictionary<string, PlacementItem>>(itemsEl.GetRawText(), jsonOpts);
            list = dict?.Values.ToList();
        }
        if (list == null) return map;
        foreach (var item in list)
        {
            var key = MergeKey(item);
            if (key != "" && !map.ContainsKey(key)) map[key] = item;
        }
        return map;
    }
    catch
    {
        return new Dictionary<string, PlacementItem>(StringComparer.Ordinal);
    }
}

static void SaveHour(string dir, int hour, IEnumerable<PlacementItem> items, JsonSerializerOptions jsonOpts)
{
    var file = Path.Combine(dir, hour.ToString("D2") + ".json");
    var sorted = items.OrderBy(i => i.CreatedAt ?? "", StringComparer.Ordinal).ToList();
    var obj = new { updatedAt = DateTime.UtcNow.ToString("o"), operation = "placement", items = sorted };
    var json = JsonSerializer.Serialize(obj, jsonOpts);
    // Атомарная запись (tmp + rename) — на случай параллельных вызовов на один файл.
    var tmp = file + ".tmp" + Environment.ProcessId;
    File.WriteAllText(tmp, json);
    File.Move(tmp, file, overwrite: true);
}

static void WriteResult(int added, int skipped, Dictionary<string, bool> byShift)
{
    var res = new { ok = true, added, skipped, byShift };
    Console.WriteLine(JsonSerializer.Serialize(res));
}

record ResponsibleUserLite
{
    public string Id { get; set; } = "";
    public string FirstName { get; set; } = "";
    public string LastName { get; set; } = "";
    public string MiddleName { get; set; } = "";
}

record PlacementItem
{
    public string Id { get; set; } = "";
    public string Status { get; set; } = "";
    public string HandlingUnitBarcode { get; set; } = "";
    public string SourceCellAddress { get; set; } = "";
    public string TargetCellAddress { get; set; } = "";
    public JsonArray TargetCellsAddresses { get; set; } = new();
    public string SourceZoneId { get; set; } = "";
    public string SourceZoneName { get; set; } = "";
    public ResponsibleUserLite ResponsibleUser { get; set; } = new();
    public string ExecutorId { get; set; } = "";
    public string Executor { get; set; } = "";
    public string? CreatedAt { get; set; }
    public string? CompletedAt { get; set; }
    public string Issue { get; set; } = "";
    public string Condition { get; set; } = "";
    public string TemperatureMode { get; set; } = "";
    public decimal SkuCount { get; set; } = 0;
}
