using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using ExcelDataReader;
using Npgsql;

namespace BackendDotnet.Services;

// Веса и штрихкоды товаров (перенесено из Node product-weights.js 2026-10-31).
//
// Источник — Excel из PowerBI (Настройки → Веса товаров): «Артикул товара»,
// «Вес товара», «ШК товара» (у артикула несколько строк — по строке на
// штрихкод), «ШК упаковки N» + «Вложенность упаковки N» (скан коробки = её
// содержимое). Файл лежит на диске (node-persist/data/product-weights.xlsx),
// по нему пересобираются таблицы product_weights и product_barcodes — их
// читают статистика, отчёты и «Поиск потеряшек». Таблицы общие для складов.
//
// Дозапрошенное из WMS для товаров без веса в Excel — в product_weights_wms
// (раньше product-weights-wms.json): новая загрузка Excel его не стирает,
// но Excel главнее — вес из WMS идёт в справочник, только если артикула нет.
public class ProductWeightsService
{
    public static readonly string DataDir = Environment.GetEnvironmentVariable("NODE_DATA_DIR") ?? "/data/node-persist/data";
    public static string ExcelPath => Path.Combine(DataDir, "product-weights.xlsx");
    private static readonly SemaphoreSlim Lock = new(1, 1);

    private readonly string _connString;
    public ProductWeightsService(IConfiguration cfg) => _connString = cfg["ConnectionStrings:Postgres"]!;

    static ProductWeightsService() => System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);

    private record Barcode(string Article, decimal Qty);
    public record WmsPackage(string Barcode, decimal Qty);
    public record WmsEntry(string Article, decimal Grams, string? ProductId, string? Name, List<string> Barcodes, List<WmsPackage> Packages);

    // ─── схема и разовый перенос product-weights-wms.json ────────────────────

    public static async Task EnsureSchemaAsync(NpgsqlConnection conn)
    {
        async Task Exec(string sql) { await using var cmd = new NpgsqlCommand(sql, conn); await cmd.ExecuteNonQueryAsync(); }
        await Exec("CREATE TABLE IF NOT EXISTS product_weights (article TEXT PRIMARY KEY, grams NUMERIC NOT NULL)");
        await Exec(@"CREATE TABLE IF NOT EXISTS product_weights_wms (
            article TEXT PRIMARY KEY, grams NUMERIC NOT NULL DEFAULT 0, product_id TEXT, name TEXT NOT NULL DEFAULT '',
            barcodes JSONB NOT NULL DEFAULT '[]', packages JSONB NOT NULL DEFAULT '[]', fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())");

        var legacy = Path.Combine(DataDir, "product-weights-wms.json");
        if (!File.Exists(legacy)) return;
        await using (var cnt = new NpgsqlCommand("SELECT count(*) FROM product_weights_wms", conn))
            if ((long)(await cnt.ExecuteScalarAsync())! > 0) return;
        try
        {
            using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(legacy));
            var n = 0;
            foreach (var p in doc.RootElement.EnumerateObject())
            {
                var r = p.Value;
                await using var cmd = new NpgsqlCommand(@"INSERT INTO product_weights_wms (article, grams, product_id, name, barcodes, packages, fetched_at)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, COALESCE($7::timestamptz, now())) ON CONFLICT DO NOTHING", conn);
                cmd.Parameters.AddWithValue(p.Name);
                cmd.Parameters.AddWithValue(r.TryGetProperty("grams", out var g) && g.TryGetDecimal(out var gd) ? gd : 0m);
                cmd.Parameters.AddWithValue(r.TryGetProperty("productId", out var pid) && pid.ValueKind == JsonValueKind.String ? pid.GetString()! : DBNull.Value);
                cmd.Parameters.AddWithValue(r.TryGetProperty("name", out var nm) && nm.ValueKind == JsonValueKind.String ? nm.GetString()! : "");
                cmd.Parameters.AddWithValue(r.TryGetProperty("barcodes", out var bc) ? bc.GetRawText() : "[]");
                cmd.Parameters.AddWithValue(r.TryGetProperty("packages", out var pk) ? pk.GetRawText() : "[]");
                cmd.Parameters.AddWithValue(r.TryGetProperty("fetchedAt", out var fa) && fa.ValueKind == JsonValueKind.String ? fa.GetString()! : DBNull.Value);
                await cmd.ExecuteNonQueryAsync();
                n++;
            }
            Console.WriteLine($"[product-weights] перенесено из product-weights-wms.json: {n}");
        }
        catch (Exception err) { Console.WriteLine($"[product-weights] product-weights-wms.json: {err.Message}"); }
    }

    // ─── разбор Excel ─────────────────────────────────────────────────────────

    // число из ячейки как строка: штрихкоды бывают числами (4600000000000.0)
    private static string CellStr(object? v) => v switch
    {
        null => "",
        double d when d % 1 == 0 && Math.Abs(d) < 1e17 => ((long)d).ToString(CultureInfo.InvariantCulture),
        double d => d.ToString(CultureInfo.InvariantCulture),
        DateTime dt => dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        _ => Convert.ToString(v, CultureInfo.InvariantCulture)?.Trim() ?? "",
    };

    // «1,5 кг», «500 г», «0.33 л», голое число — килограммы
    private static readonly Regex WeightRe = new(@"^(\d+(?:\.\d+)?)\s*(кг|г|kg|g|л|l|мл|ml)?$", RegexOptions.IgnoreCase);
    private static decimal ParseWeight(object? v)
    {
        var s = CellStr(v).Replace(',', '.').Replace(' ', ' ').Replace(' ', ' ').Trim();
        var m = WeightRe.Match(s);
        if (!m.Success) return 0;
        var x = decimal.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        return m.Groups[2].Value.ToLowerInvariant() switch { "г" or "g" or "мл" or "ml" => x, _ => x * 1000 };
    }

    private static readonly char[] CodeSeparators = { ',', ';', ' ', '\t', '\n', '\r' };
    private static IEnumerable<string> SplitCodes(object? v) => CellStr(v).Split(CodeSeparators, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static (Dictionary<string, decimal> Weights, Dictionary<string, Barcode> Barcodes) ParseExcel(string path)
    {
        var weights = new Dictionary<string, decimal>();
        var barcodes = new Dictionary<string, Barcode>();
        using var stream = File.OpenRead(path);
        using var reader = ExcelReaderFactory.CreateReader(stream);

        // строка заголовков — среди первых 5
        List<string>? headers = null;
        for (var i = 0; i < 5 && reader.Read(); i++)
        {
            var row = Enumerable.Range(0, reader.FieldCount).Select(c => CellStr(reader.GetValue(c))).ToList();
            if (row.Contains("Артикул товара")) { headers = row; break; }
        }
        if (headers == null) { Console.WriteLine("[product-weights] нет строки заголовков в Excel"); return (weights, barcodes); }

        int Col(string name) => headers.FindIndex(h => h.Trim() == name);
        int artIdx = Col("Артикул товара"), weightIdx = Col("Вес товара"), barcodeIdx = Col("ШК товара");
        if (artIdx < 0 || weightIdx < 0) { Console.WriteLine("[product-weights] нет столбцов артикула/веса"); return (weights, barcodes); }
        var packCols = new[] { 1, 2, 3, 4 }.Select(n => (Bc: Col($"ШК упаковки {n}"), Nest: Col($"Вложенность упаковки {n}")))
            .Where(p => p.Bc >= 0 && p.Nest >= 0).ToList();

        object? Get(int c) => c < reader.FieldCount ? reader.GetValue(c) : null;
        while (reader.Read())
        {
            var art = CellStr(Get(artIdx));
            if (art == "") continue;
            // штучный штрихкод главнее упаковочного: у части товаров в «ШК
            // упаковки» стоят их же штучные — иначе скан штуки шёл бы за коробку
            if (barcodeIdx >= 0)
                foreach (var code in SplitCodes(Get(barcodeIdx)))
                    if (!barcodes.TryGetValue(code, out var cur) || cur.Qty > 1) barcodes[code] = new(art, 1);
            foreach (var p in packCols)
            {
                decimal.TryParse(CellStr(Get(p.Nest)).Replace(',', '.'), NumberStyles.Any, CultureInfo.InvariantCulture, out var nest);
                if (nest <= 1) continue;
                foreach (var code in SplitCodes(Get(p.Bc))) barcodes.TryAdd(code, new(art, nest));
            }
            if (weights.ContainsKey(art)) continue; // вес — из первой строки артикула
            var grams = ParseWeight(Get(weightIdx));
            if (grams > 0) weights[art] = grams;
        }
        return (weights, barcodes);
    }

    // ─── пересборка справочника: Excel + данные из WMS ───────────────────────

    private async Task<List<WmsEntry>> LoadWmsAsync(NpgsqlConnection conn)
    {
        var list = new List<WmsEntry>();
        await using var cmd = new NpgsqlCommand("SELECT article, grams, product_id, name, barcodes::text, packages::text FROM product_weights_wms", conn);
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync())
        {
            var bcs = JsonSerializer.Deserialize<List<string>>(r.GetString(4)) ?? new();
            var pks = new List<WmsPackage>();
            using (var doc = JsonDocument.Parse(r.GetString(5)))
                foreach (var p in doc.RootElement.EnumerateArray())
                    if (p.TryGetProperty("barcode", out var b) && p.TryGetProperty("qty", out var q) && q.TryGetDecimal(out var qd))
                        pks.Add(new(b.ToString(), qd));
            list.Add(new(r.GetString(0), r.GetDecimal(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), bcs, pks));
        }
        return list;
    }

    private static void MergeWmsBarcodes(Dictionary<string, Barcode> barcodes, IEnumerable<WmsEntry> wms)
    {
        foreach (var e in wms)
        {
            foreach (var code in e.Barcodes)
                if (!barcodes.TryGetValue(code, out var cur) || cur.Qty > 1) barcodes[code] = new(e.Article, 1);
            foreach (var pk in e.Packages)
                if (pk.Barcode != "" && pk.Qty > 1) barcodes.TryAdd(pk.Barcode, new(e.Article, pk.Qty));
        }
    }

    /// Пересобрать product_weights и product_barcodes. Возвращает число артикулов с весом.
    public async Task<int> RebuildAsync()
    {
        await Lock.WaitAsync();
        try
        {
            var (weights, barcodes) = File.Exists(ExcelPath) ? ParseExcel(ExcelPath) : (new(), new());
            await using var conn = new NpgsqlConnection(_connString);
            await conn.OpenAsync();
            var wms = await LoadWmsAsync(conn);
            foreach (var e in wms) if (e.Grams > 0) weights.TryAdd(e.Article, e.Grams);
            MergeWmsBarcodes(barcodes, wms);

            await using var tx = await conn.BeginTransactionAsync();
            await using (var t = new NpgsqlCommand("TRUNCATE product_weights; TRUNCATE product_barcodes;", conn, tx)) await t.ExecuteNonQueryAsync();
            foreach (var chunk in weights.Chunk(5000))
            {
                await using var cmd = new NpgsqlCommand("INSERT INTO product_weights (article, grams) SELECT * FROM unnest($1::text[], $2::numeric[])", conn, tx);
                cmd.Parameters.AddWithValue(chunk.Select(k => k.Key).ToArray());
                cmd.Parameters.AddWithValue(chunk.Select(k => k.Value).ToArray());
                await cmd.ExecuteNonQueryAsync();
            }
            foreach (var chunk in barcodes.Chunk(5000))
            {
                await using var cmd = new NpgsqlCommand("INSERT INTO product_barcodes (barcode, article, qty) SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[]) ON CONFLICT (barcode) DO NOTHING", conn, tx);
                cmd.Parameters.AddWithValue(chunk.Select(k => k.Key).ToArray());
                cmd.Parameters.AddWithValue(chunk.Select(k => k.Value.Article).ToArray());
                cmd.Parameters.AddWithValue(chunk.Select(k => k.Value.Qty).ToArray());
                await cmd.ExecuteNonQueryAsync();
            }
            await tx.CommitAsync();
            Console.WriteLine($"[product-weights] справочник: {weights.Count} артикулов, {barcodes.Count} штрихкодов");
            return weights.Count;
        }
        finally { Lock.Release(); }
    }

    // ─── то, что браузер дозапросил у WMS ─────────────────────────────────────

    /// Сохранить карточки из WMS; вес — в справочник, только если артикула там нет.
    public async Task<int> AddWmsAsync(List<WmsEntry> entries)
    {
        await Lock.WaitAsync();
        try
        {
            await using var conn = new NpgsqlConnection(_connString);
            await conn.OpenAsync();
            await using var tx = await conn.BeginTransactionAsync();
            var saved = 0;
            foreach (var e in entries)
            {
                if (e.Article == "" || (e.Grams <= 0 && e.Barcodes.Count == 0 && e.Packages.Count == 0)) continue;
                await using (var cmd = new NpgsqlCommand(@"
                    INSERT INTO product_weights_wms (article, grams, product_id, name, barcodes, packages, fetched_at)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
                    ON CONFLICT (article) DO UPDATE SET
                      grams = CASE WHEN EXCLUDED.grams > 0 THEN EXCLUDED.grams ELSE product_weights_wms.grams END,
                      product_id = COALESCE(EXCLUDED.product_id, product_weights_wms.product_id),
                      name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE product_weights_wms.name END,
                      barcodes = EXCLUDED.barcodes, packages = EXCLUDED.packages, fetched_at = now()", conn, tx))
                {
                    cmd.Parameters.AddWithValue(e.Article);
                    cmd.Parameters.AddWithValue(e.Grams > 0 ? e.Grams : 0m);
                    cmd.Parameters.AddWithValue((object?)e.ProductId ?? DBNull.Value);
                    cmd.Parameters.AddWithValue(e.Name ?? "");
                    cmd.Parameters.AddWithValue(JsonSerializer.Serialize(e.Barcodes));
                    cmd.Parameters.AddWithValue(JsonSerializer.Serialize(e.Packages.Select(p => new { barcode = p.Barcode, qty = p.Qty })));
                    await cmd.ExecuteNonQueryAsync();
                }
                saved++;
                if (e.Grams > 0)
                {
                    await using var w = new NpgsqlCommand("INSERT INTO product_weights (article, grams) VALUES ($1, $2) ON CONFLICT DO NOTHING", conn, tx);
                    w.Parameters.AddWithValue(e.Article); w.Parameters.AddWithValue(e.Grams);
                    await w.ExecuteNonQueryAsync();
                }
                // штучный штрихкод вытесняет упаковочный, упаковка — только новый
                foreach (var code in e.Barcodes)
                {
                    await using var b = new NpgsqlCommand(@"INSERT INTO product_barcodes (barcode, article, qty) VALUES ($1, $2, 1)
                        ON CONFLICT (barcode) DO UPDATE SET article = EXCLUDED.article, qty = 1 WHERE product_barcodes.qty > 1", conn, tx);
                    b.Parameters.AddWithValue(code); b.Parameters.AddWithValue(e.Article);
                    await b.ExecuteNonQueryAsync();
                }
                foreach (var pk in e.Packages)
                {
                    await using var b = new NpgsqlCommand("INSERT INTO product_barcodes (barcode, article, qty) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", conn, tx);
                    b.Parameters.AddWithValue(pk.Barcode); b.Parameters.AddWithValue(e.Article); b.Parameters.AddWithValue(pk.Qty);
                    await b.ExecuteNonQueryAsync();
                }
            }
            await tx.CommitAsync();
            return saved;
        }
        finally { Lock.Release(); }
    }

    public async Task<(long Weights, long Wms, long Barcodes)> CountsAsync()
    {
        await using var conn = new NpgsqlConnection(_connString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT (SELECT count(*) FROM product_weights), (SELECT count(*) FROM product_weights_wms), (SELECT count(*) FROM product_barcodes)", conn);
        await using var r = await cmd.ExecuteReaderAsync();
        await r.ReadAsync();
        return (r.GetInt64(0), r.GetInt64(1), r.GetInt64(2));
    }
}
