using System.Text.Json;
using System.Text.Json.Nodes;

// Порт backend/storage.js (normalizeRemainsItem/placementMoscowDateHour/
// loadRemainsHour/saveRemainsItems) — см. SavePlacementData/Program.cs для
// полного описания приёма (тот же паттерн, что и tools/SaveFetchedData).
// Первичный таймстамп — createdAt (как у placement), merge-key длиннее
// (id | createdAt|executorId|sourceHU|targetHU), есть consolidationItems
// (произвольный массив, сохраняется как есть — не разбирается).

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

    var bySlot = new Dictionary<(string Date, int Hour), List<RemainsItem>>();
    foreach (var raw in items.EnumerateArray())
    {
        if (raw.ValueKind != JsonValueKind.Object) continue;
        var item = NormalizeRemainsItem(raw);
        if (string.IsNullOrEmpty(item.CreatedAt)) continue;
        var slot = MoscowDateHour(item.CreatedAt);
        if (slot == null) continue;
        var key = (slot.Value.DateStr, slot.Value.Hour);
        if (!bySlot.TryGetValue(key, out var list))
        {
            list = new List<RemainsItem>();
            bySlot[key] = list;
        }
        list.Add(item);
    }

    foreach (var kv in bySlot)
    {
        var dateStr = kv.Key.Date;
        var hour = kv.Key.Hour;
        var dir = Path.Combine(dataDir, dateStr, "remains");
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
                    ConsolidationItems = item.ConsolidationItems.Count > 0 ? item.ConsolidationItems : existing.ConsolidationItems,
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

static RemainsItem NormalizeRemainsItem(JsonElement raw)
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
    return new RemainsItem
    {
        Id = GetString(raw, "id").Trim(),
        Status = GetString(raw, "status"),
        TaskType = GetString(raw, "taskType"),
        SourceCellAddress = GetString(raw, "sourceCellAddress"),
        SourceHandlingUnitBarcode = GetString(raw, "sourceHandlingUnitBarcode"),
        TargetCellAddress = GetString(raw, "targetCellAddress"),
        TargetHandlingUnitBarcode = GetString(raw, "targetHandlingUnitBarcode"),
        ConsolidationItems = GetJsonArray(raw, "consolidationItems"),
        ResponsibleUser = responsibleUser,
        ExecutorId = responsibleUser.Id,
        Executor = !string.IsNullOrEmpty(nameJoined) ? nameJoined : responsibleUser.Id,
        CreatedAt = createdAt,
        CompletedAt = createdAt,
    };
}

static string MergeKey(RemainsItem item)
{
    if (item.Id != "") return item.Id;
    return $"{item.CreatedAt}|{item.ExecutorId}|{item.SourceHandlingUnitBarcode}|{item.TargetHandlingUnitBarcode}";
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

static Dictionary<string, RemainsItem> LoadHour(string dir, int hour, JsonSerializerOptions jsonOpts)
{
    var map = new Dictionary<string, RemainsItem>(StringComparer.Ordinal);
    var fp = Path.Combine(dir, hour.ToString("D2") + ".json");
    if (!File.Exists(fp)) return map;
    try
    {
        using var fs = File.OpenRead(fp);
        using var doc = JsonDocument.Parse(fs);
        if (!doc.RootElement.TryGetProperty("items", out var itemsEl)) return map;

        List<RemainsItem>? list = null;
        if (itemsEl.ValueKind == JsonValueKind.Array)
        {
            list = JsonSerializer.Deserialize<List<RemainsItem>>(itemsEl.GetRawText(), jsonOpts);
        }
        else if (itemsEl.ValueKind == JsonValueKind.Object)
        {
            var dict = JsonSerializer.Deserialize<Dictionary<string, RemainsItem>>(itemsEl.GetRawText(), jsonOpts);
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
        return new Dictionary<string, RemainsItem>(StringComparer.Ordinal);
    }
}

static void SaveHour(string dir, int hour, IEnumerable<RemainsItem> items, JsonSerializerOptions jsonOpts)
{
    var file = Path.Combine(dir, hour.ToString("D2") + ".json");
    var sorted = items.OrderBy(i => i.CreatedAt ?? "", StringComparer.Ordinal).ToList();
    var obj = new { updatedAt = DateTime.UtcNow.ToString("o"), operation = "remains", items = sorted };
    var json = JsonSerializer.Serialize(obj, jsonOpts);
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

record RemainsItem
{
    public string Id { get; set; } = "";
    public string Status { get; set; } = "";
    public string TaskType { get; set; } = "";
    public string SourceCellAddress { get; set; } = "";
    public string SourceHandlingUnitBarcode { get; set; } = "";
    public string TargetCellAddress { get; set; } = "";
    public string TargetHandlingUnitBarcode { get; set; } = "";
    public JsonArray ConsolidationItems { get; set; } = new();
    public ResponsibleUserLite ResponsibleUser { get; set; } = new();
    public string ExecutorId { get; set; } = "";
    public string Executor { get; set; } = "";
    public string? CreatedAt { get; set; }
    public string? CompletedAt { get; set; }
}
