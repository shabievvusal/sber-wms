using System.Text.Json;
using Npgsql;

namespace BackendDotnet.Services;

// Склады (РЦ). Сайт работает для всех складов WMS, данные каждого склада —
// отдельно. Здесь:
//  - справочник складов (warehouses) — засеян списком из WMS
//    (GET wmsin-wwh/warehouses) и обновляется оттуда при каждом входе с
//    WMS-токеном;
//  - к каким складам у пользователя есть доступ (vs_user_warehouses).
//    Назначает администратор; при появлении таблицы все существующие
//    пользователи один раз получают склад по умолчанию (СПБ-3) — данные,
//    накопленные до разделения по складам, — это данные СПБ-3;
//  - какой склад выбран в запросе: заголовок X-Warehouse (ставит сайт,
//    lib/api.js) с проверкой, что склад пользователю доступен.
//
// Разработчик (VS_DEVELOPER_LOGINS) видит все склады и управляет всеми.
// Администратор склада управляет только пользователями своих складов.
public class WarehouseService
{
    // СПБ-3 — склад, для которого сайт делался изначально
    public const string DefaultWarehouseId = "0087831f-9906-11ee-8861-08c0eb32014b";
    public const string HeaderName = "X-Warehouse";
    private const string WmsWarehousesUrl = "https://api.samokat.ru/wmsin-wwh/warehouses";

    // список из WMS на 2026-10-15 — чтобы справочник был сразу, до первого входа
    private static readonly (string Id, string Name)[] Seed =
    {
        ("39708631-f307-11ed-885e-08c0eb32014b", "РЦ СБЛ  МСК-3"),
        ("925fa366-4386-11ef-ae7a-08c0eb320147", "РЦ СБЛ ВЛГ-2 WMS"),
        ("678f4b10-6d59-11f0-aa3c-be3af2b6059f", "РЦ СБЛ ВРЖ Нечаевка"),
        ("c251aea6-2fc2-11ef-b10b-08c0eb31fffb", "РЦ СБЛ ВРЖ-3"),
        ("90692587-4e33-11ee-ae78-08c0eb320147", "РЦ СБЛ ЕКБ-2"),
        ("d7cceffd-a1e2-11f1-9ee2-be3af2b6059f", "РЦ СБЛ ЕКБ-ТМН-2"),
        ("511727d8-75e6-11f1-9ee2-be3af2b6059f", "РЦ СБЛ ИВВ-2 WMS"),
        ("abbb9e3e-bc1f-11ed-885d-08c0eb32014b", "РЦ СБЛ КНД-3"),
        ("a60f0824-7cd7-11ef-ae7a-08c0eb320147", "РЦ СБЛ КСК"),
        ("33d9372f-7a07-11f1-9ee2-be3af2b6059f", "РЦ СБЛ КСК-3 WMS"),
        ("23ae9ff6-9c60-11eb-85a9-1c34dae33151", "РЦ СБЛ МСК-2"),
        ("48847d92-0244-11ef-b973-08c0eb32008b", "РЦ СБЛ МСК-4"),
        ("23cfc01c-496b-11ed-885a-08c0eb32014b", "РЦ СБЛ НН"),
        ("499eeee5-5f2b-11eb-85a3-1c34dae33151", "РЦ СБЛ НСК"),
        ("e57b1eb1-015e-11ef-8861-08c0eb32014b", "РЦ СБЛ РНД-2"),
        ("7307ea02-496c-11ed-885a-08c0eb32014b", "РЦ СБЛ СМР"),
        ("d17e5c60-9ce6-11ef-8861-08c0eb32014b", "РЦ СБЛ СМР-2"),
        ("0087831f-9906-11ee-8861-08c0eb32014b", "РЦ СБЛ СПБ-3"),
        ("c1b19790-da4d-11ef-9bb0-be3af2b6059f", "РЦ СБЛ ТМН"),
        ("909578fd-648e-11ef-ae7a-08c0eb320147", "РЦ СБЛ ТУЛ"),
        ("5cfdef61-b28e-11ed-b970-08c0eb32008b", "РЦ СБЛ УФА-2"),
    };

    public record Warehouse(string Id, string Name);

    /// <summary>Ключ пользователя в vs_user_warehouses: телефон — +7XXXXXXXXXX
    /// (в сессии логин хранится как введён: 79…, 8…), буквенный — в нижнем регистре.</summary>
    public static string Key(string? login)
    {
        var t = (login ?? "").Trim();
        if (t == "") return "";
        return AuthService.IsLetterLogin(t) ? t.ToLowerInvariant() : (AuthService.CanonicalPhone(t) ?? t);
    }

    private readonly string _connectionString;
    private static volatile bool _ready;
    private static readonly SemaphoreSlim _initLock = new(1, 1);
    private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(10) };

    public WarehouseService(IConfiguration config)
    {
        _connectionString = config.GetConnectionString("Postgres")!;
    }

    private async Task<NpgsqlConnection> OpenAsync()
    {
        var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync();
        await EnsureSchemaAsync(conn);
        return conn;
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection conn)
    {
        if (_ready) return;
        await _initLock.WaitAsync();
        try
        {
            if (_ready) return;
            await using (var cmd = new NpgsqlCommand(@"
                CREATE TABLE IF NOT EXISTS warehouses (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                );
                ALTER TABLE vs_pending_users ADD COLUMN IF NOT EXISTS warehouse_id TEXT;", conn))
                await cmd.ExecuteNonQueryAsync();

            foreach (var (id, name) in Seed)
            {
                await using var ins = new NpgsqlCommand("INSERT INTO warehouses (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", conn);
                ins.Parameters.AddWithValue(id);
                ins.Parameters.AddWithValue(name);
                await ins.ExecuteNonQueryAsync();
            }

            // Таблица доступа появляется один раз — тогда же всем, кто уже
            // есть, выдаётся СПБ-3. Дальше склады назначает администратор.
            await using (var exists = new NpgsqlCommand("SELECT to_regclass('vs_user_warehouses') IS NOT NULL", conn))
            {
                var has = (bool)(await exists.ExecuteScalarAsync())!;
                if (!has)
                {
                    await using var create = new NpgsqlCommand(@"
                        CREATE TABLE vs_user_warehouses (
                            login TEXT NOT NULL,
                            warehouse_id TEXT NOT NULL,
                            PRIMARY KEY (login, warehouse_id)
                        );", conn);
                    await create.ExecuteNonQueryAsync();
                    var logins = new List<string>();
                    await using (var sel = new NpgsqlCommand("SELECT login FROM vs_users", conn))
                    await using (var rd = await sel.ExecuteReaderAsync())
                        while (await rd.ReadAsync()) if (!rd.IsDBNull(0)) logins.Add(rd.GetString(0));
                    foreach (var key in logins.Select(Key).Where(k => k != "").Distinct())
                    {
                        await using var ins = new NpgsqlCommand("INSERT INTO vs_user_warehouses (login, warehouse_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", conn);
                        ins.Parameters.AddWithValue(key);
                        ins.Parameters.AddWithValue(DefaultWarehouseId);
                        await ins.ExecuteNonQueryAsync();
                    }
                }
            }
            // права по складам (роль своя на каждом складе)
            await using (var cols = new NpgsqlCommand(@"
                ALTER TABLE vs_user_warehouses ADD COLUMN IF NOT EXISTS role TEXT;
                ALTER TABLE vs_user_warehouses ADD COLUMN IF NOT EXISTS modules JSONB;
                ALTER TABLE vs_user_warehouses ADD COLUMN IF NOT EXISTS actions JSONB;", conn))
                await cols.ExecuteNonQueryAsync();
            _ready = true;
        }
        finally { _initLock.Release(); }
    }

    // ─── Справочник ─────────────────────────────────────────────────────────

    public async Task<List<Warehouse>> GetAllAsync()
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT id, name FROM warehouses ORDER BY name", conn);
        await using var r = await cmd.ExecuteReaderAsync();
        var list = new List<Warehouse>();
        while (await r.ReadAsync()) list.Add(new Warehouse(r.GetString(0), r.GetString(1)));
        return list;
    }

    /// <summary>Обновить справочник из WMS токеном вошедшего пользователя.
    /// Ошибки не важны — справочник уже есть, обновится при следующем входе.</summary>
    public async Task RefreshFromWmsAsync(string? accessToken)
    {
        if (string.IsNullOrEmpty(accessToken)) return;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, WmsWarehousesUrl);
            req.Headers.Add("Accept", "application/json");
            req.Headers.Add("Authorization", "Bearer " + accessToken);
            req.Headers.Add("Origin", "https://wwh.samokat.ru");
            req.Headers.Add("Referer", "https://wwh.samokat.ru/");
            using var res = await _http.SendAsync(req);
            if (!res.IsSuccessStatusCode) return;
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            if (!doc.RootElement.TryGetProperty("value", out var value) ||
                !value.TryGetProperty("warehouses", out var arr) || arr.ValueKind != JsonValueKind.Array) return;
            await using var conn = await OpenAsync();
            foreach (var w in arr.EnumerateArray())
            {
                var id = w.TryGetProperty("id", out var i) ? i.GetString() : null;
                var name = w.TryGetProperty("name", out var n) ? n.GetString() : null;
                if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(name)) continue;
                await using var up = new NpgsqlCommand(@"
                    INSERT INTO warehouses (id, name) VALUES ($1, $2)
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
                    WHERE warehouses.name IS DISTINCT FROM EXCLUDED.name", conn);
                up.Parameters.AddWithValue(id);
                up.Parameters.AddWithValue(name.Trim());
                await up.ExecuteNonQueryAsync();
            }
        }
        catch (Exception e) { Console.Error.WriteLine($"warehouses refresh: {e.Message}"); }
    }

    // ─── Доступ пользователей ───────────────────────────────────────────────
    // Строка vs_user_warehouses — доступ к складу и права на нём: роль,
    // разделы, действия. null — «как у пользователя» (vs_users): так у всех,
    // кто был до разделения ролей по складам, права не меняются.

    public record Access(string WarehouseId, string? Role, List<string>? Modules, List<string>? Actions);

    private static Access ReadAccess(NpgsqlDataReader r, int at) => new(
        r.GetString(at),
        r.IsDBNull(at + 1) ? null : r.GetString(at + 1),
        r.IsDBNull(at + 2) ? null : ParseList(r.GetString(at + 2)),
        r.IsDBNull(at + 3) ? null : ParseList(r.GetString(at + 3)));

    private static List<string>? ParseList(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return JsonSerializer.Deserialize<List<string>>(json); } catch { return null; }
    }

    private static object Json(List<string>? list) => list == null ? DBNull.Value : JsonSerializer.Serialize(list);

    /// <summary>Склады пользователя (id). Разработчику — все.</summary>
    public async Task<List<string>> GetUserWarehouseIdsAsync(string? login, string? role)
    {
        if (role == "developer") return (await GetAllAsync()).Select(w => w.Id).ToList();
        return (await GetUserAccessAsync(login)).Select(a => a.WarehouseId).ToList();
    }

    /// <summary>Права пользователя по складам (как записаны, без подстановки).</summary>
    public async Task<List<Access>> GetUserAccessAsync(string? login)
    {
        var key = Key(login);
        if (key == "") return new();
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT warehouse_id, role, modules, actions FROM vs_user_warehouses WHERE login = $1", conn);
        cmd.Parameters.AddWithValue(key);
        await using var r = await cmd.ExecuteReaderAsync();
        var list = new List<Access>();
        while (await r.ReadAsync()) list.Add(ReadAccess(r, 0));
        return list;
    }

    /// <summary>Ключ логина (см. Key) → его права по складам (для списка пользователей в Настройках).</summary>
    public async Task<Dictionary<string, List<Access>>> GetAllAccessAsync()
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT login, warehouse_id, role, modules, actions FROM vs_user_warehouses", conn);
        await using var r = await cmd.ExecuteReaderAsync();
        var map = new Dictionary<string, List<Access>>(StringComparer.Ordinal);
        while (await r.ReadAsync())
        {
            var login = r.GetString(0);
            if (!map.TryGetValue(login, out var list)) map[login] = list = new();
            list.Add(ReadAccess(r, 1));
        }
        return map;
    }

    /// <summary>Задать склады пользователя (без прав на них — права, что уже
    /// были, сохраняются; у новых — <paramref name="role"/>). Меняются только
    /// склады из <paramref name="manageable"/> — остальные склады пользователя
    /// администратор чужого склада не трогает.</summary>
    public async Task SetUserWarehousesAsync(string login, IEnumerable<string> wanted, ICollection<string> manageable, string? role = null)
    {
        var target = wanted.Where(manageable.Contains).ToHashSet();
        await using var conn = await OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var del = new NpgsqlCommand("DELETE FROM vs_user_warehouses WHERE login = $1 AND warehouse_id = ANY($2) AND NOT (warehouse_id = ANY($3))", conn, tx))
        {
            del.Parameters.AddWithValue(Key(login));
            del.Parameters.AddWithValue(manageable.ToArray());
            del.Parameters.AddWithValue(target.ToArray());
            await del.ExecuteNonQueryAsync();
        }
        foreach (var id in target)
        {
            await using var ins = new NpgsqlCommand("INSERT INTO vs_user_warehouses (login, warehouse_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", conn, tx);
            ins.Parameters.AddWithValue(Key(login));
            ins.Parameters.AddWithValue(id);
            ins.Parameters.AddWithValue((object?)role ?? DBNull.Value);
            await ins.ExecuteNonQueryAsync();
        }
        await tx.CommitAsync();
    }

    /// <summary>Склады пользователя вместе с правами на каждом (карточка
    /// пользователя в Настройках). Только склады из <paramref name="manageable"/>.</summary>
    public async Task SetUserAccessAsync(string login, IEnumerable<Access> wanted, ICollection<string> manageable)
    {
        var target = wanted.Where(a => manageable.Contains(a.WarehouseId)).GroupBy(a => a.WarehouseId).Select(g => g.Last()).ToList();
        await using var conn = await OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var del = new NpgsqlCommand("DELETE FROM vs_user_warehouses WHERE login = $1 AND warehouse_id = ANY($2)", conn, tx))
        {
            del.Parameters.AddWithValue(Key(login));
            del.Parameters.AddWithValue(manageable.ToArray());
            await del.ExecuteNonQueryAsync();
        }
        foreach (var a in target)
        {
            await using var ins = new NpgsqlCommand("INSERT INTO vs_user_warehouses (login, warehouse_id, role, modules, actions) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)", conn, tx);
            ins.Parameters.AddWithValue(Key(login));
            ins.Parameters.AddWithValue(a.WarehouseId);
            ins.Parameters.AddWithValue((object?)a.Role ?? DBNull.Value);
            ins.Parameters.AddWithValue(Json(a.Modules));
            ins.Parameters.AddWithValue(Json(a.Actions));
            await ins.ExecuteNonQueryAsync();
        }
        await tx.CommitAsync();
    }

    /// <summary>Поменять права на одном складе (массовые действия в Настройках).
    /// Пользователя без этого склада не трогает. false — склада у него нет.</summary>
    public async Task<bool> UpdateAccessAsync(string login, string warehouseId,
        bool roleSet, string? role, bool modulesSet, List<string>? modules, bool actionsSet, List<string>? actions)
    {
        var sets = new List<string>();
        if (roleSet) sets.Add("role = $3");
        if (modulesSet) sets.Add("modules = $4::jsonb");
        if (actionsSet) sets.Add("actions = $5::jsonb");
        await using var conn = await OpenAsync();
        if (sets.Count == 0)
        {
            await using var has = new NpgsqlCommand("SELECT 1 FROM vs_user_warehouses WHERE login = $1 AND warehouse_id = $2", conn);
            has.Parameters.AddWithValue(Key(login));
            has.Parameters.AddWithValue(warehouseId);
            return await has.ExecuteScalarAsync() != null;
        }
        await using var cmd = new NpgsqlCommand($"UPDATE vs_user_warehouses SET {string.Join(", ", sets)} WHERE login = $1 AND warehouse_id = $2", conn);
        cmd.Parameters.AddWithValue(Key(login));
        cmd.Parameters.AddWithValue(warehouseId);
        cmd.Parameters.AddWithValue((object?)role ?? DBNull.Value);
        cmd.Parameters.AddWithValue(Json(modules));
        cmd.Parameters.AddWithValue(Json(actions));
        return await cmd.ExecuteNonQueryAsync() > 0;
    }

    public async Task RemoveUserAsync(string login)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("DELETE FROM vs_user_warehouses WHERE login = $1", conn);
        cmd.Parameters.AddWithValue(Key(login));
        await cmd.ExecuteNonQueryAsync();
    }

    // ─── Заявки на регистрацию ──────────────────────────────────────────────

    public async Task SetPendingWarehouseAsync(string normalizedPhone, string? warehouseId)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("UPDATE vs_pending_users SET warehouse_id = $2 WHERE normalized_phone = $1", conn);
        cmd.Parameters.AddWithValue(normalizedPhone);
        cmd.Parameters.AddWithValue((object?)warehouseId ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>Телефон (10 цифр) → склад заявки. Заявки до разделения по
    /// складам — СПБ-3.</summary>
    public async Task<Dictionary<string, string>> GetPendingWarehousesAsync()
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT normalized_phone, COALESCE(warehouse_id, $1) FROM vs_pending_users", conn);
        cmd.Parameters.AddWithValue(DefaultWarehouseId);
        await using var r = await cmd.ExecuteReaderAsync();
        var map = new Dictionary<string, string>();
        while (await r.ReadAsync()) map[r.GetString(0)] = r.GetString(1);
        return map;
    }

    public async Task<bool> ExistsAsync(string? id) =>
        !string.IsNullOrEmpty(id) && (await GetAllAsync()).Any(w => w.Id == id);

    // ─── Склад запроса ──────────────────────────────────────────────────────

    /// <summary>Склад, выбранный на сайте (заголовок X-Warehouse), если он
    /// доступен пользователю; без заголовка — первый доступный (СПБ-3, если
    /// он есть). null — доступа к складу нет.</summary>
    public async Task<string?> ResolveRequestWarehouseAsync(HttpContext ctx, string? login, string? role)
    {
        var allowed = await GetUserWarehouseIdsAsync(login, role);
        var asked = ctx.Request.Headers[HeaderName].ToString().Trim();
        if (asked != "") return allowed.Contains(asked) ? asked : null;
        if (allowed.Contains(DefaultWarehouseId)) return DefaultWarehouseId;
        return allowed.FirstOrDefault();
    }

    /// <summary>Как ResolveRequestWarehouseAsync, но недоступный склад в
    /// заголовке не ошибка, а «как без заголовка» (для /me: сайт сам
    /// переключится на тот же склад, см. lib/warehouse.js pick()).</summary>
    public async Task<string?> ResolveRequestWarehouseOrDefaultAsync(HttpContext ctx, string? login, string? role)
    {
        var allowed = await GetUserWarehouseIdsAsync(login, role);
        var asked = ctx.Request.Headers[HeaderName].ToString().Trim();
        if (asked != "" && allowed.Contains(asked)) return asked;
        if (allowed.Contains(DefaultWarehouseId)) return DefaultWarehouseId;
        return allowed.FirstOrDefault();
    }
}
