using System.Text.Json;

// Порт backend/storage.js (normalizeReceivingItem/placementMoscowDateHour/
// loadReceivingHour/saveReceivingItems) — см. SavePlacementData/Program.cs
// для полного описания приёма (тот же паттерн, что и tools/SaveFetchedData).
// Отличия от placement: первичный таймстамп — completedAt (не createdAt),
// responsibleUser может прийти как item.acceptedBy, отдельный eoCount, нет
// targetCellsAddresses/skuCount.

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

    var bySlot = new Dictionary<(string Date, int Hour), List<ReceivingItem>>();
    foreach (var raw in items.EnumerateArray())
    {
        if (raw.ValueKind != JsonValueKind.Object) continue;
        var item = NormalizeReceivingItem(raw);
        if (string.IsNullOrEmpty(item.CompletedAt)) continue;
        var slot = MoscowDateHour(item.CompletedAt);
        if (slot == null) continue;
        var key = (slot.Value.DateStr, slot.Value.Hour);
        if (!bySlot.TryGetValue(key, out var list))
        {
            list = new List<ReceivingItem>();
            bySlot[key] = list;
        }
        list.Add(item);
    }

    foreach (var kv in bySlot)
    {
        var dateStr = kv.Key.Date;
        var hour = kv.Key.Hour;
        var dir = Path.Combine(dataDir, dateStr, "receiving");
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
                    EoCount = item.EoCount != 0 ? item.EoCount : existing.EoCount,
                    ResponsibleUser = item.ResponsibleUser,
                    ExecutorId = item.ExecutorId != "" ? item.ExecutorId : existing.ExecutorId,
                    Executor = item.Executor != "" ? item.Executor : existing.Executor,
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

static string NormalizeUserName(string last, string first, string middle)
{
    var parts = new[] { last, first, middle }.Where(s => !string.IsNullOrWhiteSpace(s));
    return string.Join(" ", parts).Trim();
}

static ReceivingItem NormalizeReceivingItem(JsonElement raw)
{
    var completedAt = GetStringOrNull(raw, "completedAt") ?? GetStringOrNull(raw, "createdAt") ?? GetStringOrNull(raw, "updatedAt");
    // responsibleUser ?? acceptedBy — оба поля объектные, берём первое непустое.
    var ru = GetObj(raw, "responsibleUser");
    if (ru.ValueKind != JsonValueKind.Object) ru = GetObj(raw, "acceptedBy");
    var responsibleUser = new ResponsibleUserLite
    {
        Id = GetString(ru, "id"),
        FirstName = GetString(ru, "firstName"),
        LastName = GetString(ru, "lastName"),
        MiddleName = GetString(ru, "middleName"),
    };
    var nameJoined = NormalizeUserName(responsibleUser.LastName, responsibleUser.FirstName, responsibleUser.MiddleName);
    var supplierObj = GetObj(raw, "supplier");
    var supplierName = supplierObj.ValueKind == JsonValueKind.Object ? GetString(supplierObj, "name") : "";
    if (supplierName == "") supplierName = GetString(raw, "supplierName");
    return new ReceivingItem
    {
        Id = GetString(raw, "id").Trim(),
        Status = GetString(raw, "status"),
        Type = GetString(raw, "type") != "" ? GetString(raw, "type") : GetString(raw, "taskType"),
        TaskNumber = GetString(raw, "taskNumber") != "" ? GetString(raw, "taskNumber") : GetString(raw, "number"),
        OrderNumber = GetString(raw, "orderNumber"),
        SupplierName = supplierName,
        CompletedAt = completedAt,
        CreatedAt = completedAt,
        StartedAt = GetString(raw, "startedAt") != "" ? GetString(raw, "startedAt") : GetString(raw, "acceptanceStartedAt"),
        ResponsibleUser = responsibleUser,
        ExecutorId = responsibleUser.Id,
        Executor = !string.IsNullOrEmpty(nameJoined) ? nameJoined : responsibleUser.Id,
        VolumeInMilliliters = GetNumber(raw, "volumeInMilliliters"),
        WeightInGrams = GetNumber(raw, "weightInGrams") != 0 ? GetNumber(raw, "weightInGrams") : GetNumber(raw, "actualWeightInGrams"),
        EoCount = GetNumber(raw, "handlingUnitsQuantity") != 0 ? GetNumber(raw, "handlingUnitsQuantity") : GetNumber(raw, "eoCount"),
    };
}

static string MergeKey(ReceivingItem item)
{
    if (item.Id != "") return item.Id;
    return $"{item.CompletedAt}|{item.ExecutorId}|{item.TaskNumber}";
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

static Dictionary<string, ReceivingItem> LoadHour(string dir, int hour, JsonSerializerOptions jsonOpts)
{
    var map = new Dictionary<string, ReceivingItem>(StringComparer.Ordinal);
    var fp = Path.Combine(dir, hour.ToString("D2") + ".json");
    if (!File.Exists(fp)) return map;
    try
    {
        using var fs = File.OpenRead(fp);
        using var doc = JsonDocument.Parse(fs);
        if (!doc.RootElement.TryGetProperty("items", out var itemsEl)) return map;

        List<ReceivingItem>? list = null;
        if (itemsEl.ValueKind == JsonValueKind.Array)
        {
            list = JsonSerializer.Deserialize<List<ReceivingItem>>(itemsEl.GetRawText(), jsonOpts);
        }
        else if (itemsEl.ValueKind == JsonValueKind.Object)
        {
            var dict = JsonSerializer.Deserialize<Dictionary<string, ReceivingItem>>(itemsEl.GetRawText(), jsonOpts);
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
        return new Dictionary<string, ReceivingItem>(StringComparer.Ordinal);
    }
}

static void SaveHour(string dir, int hour, IEnumerable<ReceivingItem> items, JsonSerializerOptions jsonOpts)
{
    var file = Path.Combine(dir, hour.ToString("D2") + ".json");
    var sorted = items.OrderBy(i => i.CompletedAt ?? "", StringComparer.Ordinal).ToList();
    var obj = new { updatedAt = DateTime.UtcNow.ToString("o"), operation = "receiving", items = sorted };
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

record ReceivingItem
{
    public string Id { get; set; } = "";
    public string Status { get; set; } = "";
    public string Type { get; set; } = "";
    public string TaskNumber { get; set; } = "";
    public string OrderNumber { get; set; } = "";
    public string SupplierName { get; set; } = "";
    public string? CompletedAt { get; set; }
    public string? CreatedAt { get; set; }
    public string StartedAt { get; set; } = "";
    public ResponsibleUserLite ResponsibleUser { get; set; } = new();
    public string ExecutorId { get; set; } = "";
    public string Executor { get; set; } = "";
    public decimal VolumeInMilliliters { get; set; } = 0;
    public decimal WeightInGrams { get; set; } = 0;
    public decimal EoCount { get; set; } = 0;
}
