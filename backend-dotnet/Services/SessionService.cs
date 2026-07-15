using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Npgsql;

namespace BackendDotnet.Services;

public class VsSession
{
    public string Login { get; set; } = "";
    public string? Role { get; set; }
    public string? ShiftType { get; set; }
    public List<string>? CompanyIds { get; set; }
}

public class VsUser
{
    public string Login { get; set; } = "";
    public string? Name { get; set; }
    public bool SelfOnly { get; set; }
    public List<string>? VisibleCompanies { get; set; }
}

// Аналог getSession()/findUserByLogin() из vs-auth-pg.js (backend/, Фаза 0) —
// читает НАПРЯМУЮ те же таблицы vs_sessions/vs_users в базе `zlp`. dotnet не
// ходит в Node за авторизацией — сессии уже общие через Postgres.
public class SessionService
{
    private const long SessionTtlMs = 30L * 24 * 60 * 60 * 1000;
    private readonly string _connectionString;

    public SessionService(IConfiguration config)
    {
        _connectionString = config.GetConnectionString("Postgres")!;
    }

    public async Task<VsSession?> GetSessionAsync(string? sessionId)
    {
        if (string.IsNullOrEmpty(sessionId)) return null;
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "SELECT login, role, created_at, last_active_at, shift_type, company_ids FROM vs_sessions WHERE session_id = $1", conn);
        cmd.Parameters.AddWithValue(sessionId);
        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) return null;

        var login = reader.IsDBNull(0) ? "" : reader.GetString(0);
        var role = reader.IsDBNull(1) ? null : reader.GetString(1);
        var createdAt = reader.IsDBNull(2) ? 0L : reader.GetInt64(2);
        var lastActiveAt = reader.IsDBNull(3) ? 0L : reader.GetInt64(3);
        var shiftType = reader.IsDBNull(4) ? null : reader.GetString(4);
        var companyIds = reader.IsDBNull(5) ? null : ParseStringArray(reader.GetString(5));
        await reader.CloseAsync();

        var lastActive = lastActiveAt != 0 ? lastActiveAt : createdAt;
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (nowMs - lastActive > SessionTtlMs)
        {
            await using var del = new NpgsqlCommand("DELETE FROM vs_sessions WHERE session_id = $1", conn);
            del.Parameters.AddWithValue(sessionId);
            await del.ExecuteNonQueryAsync();
            return null;
        }

        return new VsSession { Login = login, Role = role, ShiftType = shiftType, CompanyIds = companyIds };
    }

    // Читает vs_sid из куки запроса напрямую (для "опциональной" сессии —
    // роуты, где отсутствие сессии не 401, а просто отключает персональные
    // фильтры, как vsSessionOptional в оригинале).
    public async Task<VsSession?> GetSessionFromCookieAsync(HttpRequest request)
    {
        var sid = request.Cookies["vs_sid"];
        return await GetSessionAsync(sid);
    }

    private static List<string>? ParseStringArray(string json)
    {
        try { return System.Text.Json.JsonSerializer.Deserialize<List<string>>(json); }
        catch { return null; }
    }

    // Порт findUserByLogin() из vs-auth-pg.js — та же логика сопоставления:
    // если у пользователя задан пароль (passwordHash), сравнение по
    // trim+lowercase логина как есть; иначе — сравнение по нормализованному
    // телефону (последние 10 цифр). Нужно 1-в-1, потому что `session.login`
    // (из vs_sessions, записан как ввёл пользователь при логине) не всегда
    // совпадает буквально с каноническим login в vs_users (+7XXXXXXXXXX).
    public async Task<VsUser?> FindUserByLoginAsync(string? login)
    {
        if (string.IsNullOrEmpty(login)) return null;
        var trimmed = login.Trim();
        var normalized = NormalizeLogin(login);

        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT login, name, password_hash, self_only, visible_companies FROM vs_users", conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var rowLogin = reader.IsDBNull(0) ? "" : reader.GetString(0);
            var rowName = reader.IsDBNull(1) ? null : reader.GetString(1);
            var rowPasswordHash = reader.IsDBNull(2) ? null : reader.GetString(2);
            var selfOnly = !reader.IsDBNull(3) && reader.GetBoolean(3);
            var visibleCompanies = reader.IsDBNull(4) ? null : ParseStringArray(reader.GetString(4));

            bool match;
            if (!string.IsNullOrEmpty(rowPasswordHash))
            {
                match = trimmed.ToLowerInvariant() == rowLogin.Trim().ToLowerInvariant();
            }
            else
            {
                var uLogin = NormalizeLogin(rowLogin);
                match = !string.IsNullOrEmpty(uLogin) && (uLogin == normalized || rowLogin == login);
            }

            if (match) return new VsUser { Login = rowLogin, Name = rowName, SelfOnly = selfOnly, VisibleCompanies = visibleCompanies };
        }
        return null;
    }

    private static string NormalizeLogin(string? login)
    {
        var digits = Regex.Replace(login ?? "", @"\D", "");
        return digits.Length > 10 ? digits[^10..] : digits;
    }
}
