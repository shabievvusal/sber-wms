using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using BackendDotnet.Models;
using Npgsql;
using CryptSharp.Utility;

namespace BackendDotnet.Services;

// Полный порт vs-auth-pg.js (backend/, Фаза 4) — роли/пользователи/сессии/
// заявки/логи входа. Читает/пишет ТЕ ЖЕ таблицы Postgres, что и Node
// (vs_users, vs_sessions — Фаза 0; vs_custom_roles/vs_pending_users/
// vs_logins — Фаза 4). Полностью асинхронно, без кэша в памяти — тот же
// принцип, что и в остальных *Service.cs.
//
// НЕ переиспользует SessionService.cs (Фаза 1, уже проверен другими
// доменами) — у него урезанный VsSession (без Modules/Name/
// AllowWithoutToken/SelfOnly, без "touch" скользящего TTL). AuthService
// держит свою полную реализацию getSession()/createSession(), 1-в-1 портируя
// vs-auth-pg.js, чтобы не трогать уже проверенный код других доменов.
public class AuthService
{
    private readonly string _connectionString;

    public AuthService(IConfiguration config)
    {
        _connectionString = config.GetConnectionString("Postgres")!;
    }

    private async Task<NpgsqlConnection> OpenAsync()
    {
        var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync();
        return conn;
    }

    // ─── Пароли (scrypt) ────────────────────────────────────────────────────

    // Node: crypto.scryptSync(password, salt, 64) — дефолты N=16384, r=8, p=1.
    // Проверено байт-в-байт против реального Node-хэша (см. backend-dotnet.csproj).
    public static string HashPassword(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = SCrypt.ComputeDerivedKey(Encoding.UTF8.GetBytes(password), salt, 16384, 8, 1, null, 64);
        return Convert.ToHexString(salt).ToLowerInvariant() + ":" + Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static bool VerifyPassword(string password, string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return false;
        var idx = stored.IndexOf(':');
        if (idx <= 0) return false;
        byte[] salt, expected;
        try
        {
            salt = Convert.FromHexString(stored[..idx]);
            expected = Convert.FromHexString(stored[(idx + 1)..]);
        }
        catch { return false; }
        var got = SCrypt.ComputeDerivedKey(Encoding.UTF8.GetBytes(password), salt, 16384, 8, 1, null, 64);
        return got.Length == expected.Length && CryptographicOperations.FixedTimeEquals(got, expected);
    }

    // ─── Нормализация логина/телефона ───────────────────────────────────────

    public static string NormalizePhone(string? phone)
    {
        var digits = Regex.Replace(phone ?? "", @"\D", "");
        return digits.Length > 10 ? digits[^10..] : digits;
    }

    public static string? CanonicalPhone(string? phone)
    {
        var digits = Regex.Replace(phone ?? "", @"\D", "");
        var ten = digits.Length > 10 ? digits[^10..] : digits;
        return ten.Length == 10 ? "+7" + ten : null;
    }

    public static string NormalizeLogin(string? login) => NormalizePhone(login);

    public static bool IsLetterLogin(string? login) => Regex.IsMatch(login?.Trim() ?? "", @"[a-zA-Zа-яА-ЯёЁ]");

    private static bool UserLoginMatch(AuthVsUser u, string login, string normalized, string trimmedLogin)
    {
        if (!string.IsNullOrEmpty(u.PasswordHash))
            return trimmedLogin.ToLowerInvariant() == u.Login.Trim().ToLowerInvariant();
        var uLogin = NormalizeLogin(u.Login);
        return (!string.IsNullOrEmpty(uLogin) && uLogin == normalized) || u.Login == login;
    }

    // ─── Custom roles (vs_custom_roles) ─────────────────────────────────────

    private async Task<Dictionary<string, CustomRole>> LoadCustomRolesAsync()
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT key, label, modules FROM vs_custom_roles", conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        var roles = new Dictionary<string, CustomRole>();
        while (await reader.ReadAsync())
        {
            var key = reader.GetString(0);
            roles[key] = new CustomRole
            {
                Key = key,
                Label = reader.GetString(1),
                Modules = ParseStringList(reader.IsDBNull(2) ? null : reader.GetString(2)) ?? new(),
            };
        }
        return roles;
    }

    public async Task<List<RoleDto>> GetAllRolesAsync()
    {
        var custom = await LoadCustomRolesAsync();
        var result = new List<RoleDto>();
        foreach (var (key, label) in AuthConstants.BuiltinRoles)
        {
            result.Add(new RoleDto
            {
                Key = key,
                Label = label,
                Modules = AuthConstants.ModulesByRole.TryGetValue(key, out var m) ? m : AuthConstants.AllModules,
                Builtin = true,
            });
        }
        foreach (var (key, v) in custom)
        {
            result.Add(new RoleDto { Key = key, Label = string.IsNullOrEmpty(v.Label) ? key : v.Label, Modules = v.Modules, Builtin = false });
        }
        return result;
    }

    public async Task<string> AddCustomRoleAsync(string? key, string? label, List<string>? modules)
    {
        var k = Regex.Replace((key ?? "").Trim().ToLowerInvariant(), "[^a-z0-9_]", "_").Trim('_');
        if (string.IsNullOrEmpty(k)) k = "role_" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString("x");
        if (AuthConstants.BuiltinRoles.ContainsKey(k)) throw new InvalidOperationException("Нельзя переопределить встроенную роль");
        if (!Regex.IsMatch(k, "^[a-z][a-z0-9_]*$")) throw new InvalidOperationException("Ключ должен начинаться с буквы и содержать только латинские буквы, цифры и _");
        var roleLabel = string.IsNullOrEmpty((label ?? "").Trim()) ? k : label!.Trim();
        var roleModules = (modules ?? new()).Where(m => AuthConstants.AllModules.Contains(m)).ToList();
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "INSERT INTO vs_custom_roles (key, label, modules) VALUES ($1, $2, $3::jsonb) ON CONFLICT (key) DO UPDATE SET label = $2, modules = $3::jsonb", conn);
        cmd.Parameters.AddWithValue(k);
        cmd.Parameters.AddWithValue(roleLabel);
        cmd.Parameters.AddWithValue(JsonSerializer.Serialize(roleModules));
        await cmd.ExecuteNonQueryAsync();
        return k;
    }

    public async Task UpdateCustomRoleAsync(string key, string? label, List<string>? modules)
    {
        if (AuthConstants.BuiltinRoles.ContainsKey(key)) throw new InvalidOperationException("Нельзя изменить встроенную роль через этот метод");
        await using var conn = await OpenAsync();
        await using var sel = new NpgsqlCommand("SELECT modules FROM vs_custom_roles WHERE key = $1", conn);
        sel.Parameters.AddWithValue(key);
        var existingModulesJson = (string?)await sel.ExecuteScalarAsync();
        if (existingModulesJson == null) throw new InvalidOperationException("Роль не найдена");
        var roleLabel = string.IsNullOrEmpty((label ?? "").Trim()) ? key : label!.Trim();
        var roleModules = modules != null ? modules.Where(m => AuthConstants.AllModules.Contains(m)).ToList() : (ParseStringList(existingModulesJson) ?? new());
        await using var upd = new NpgsqlCommand("UPDATE vs_custom_roles SET label = $2, modules = $3::jsonb WHERE key = $1", conn);
        upd.Parameters.AddWithValue(key);
        upd.Parameters.AddWithValue(roleLabel);
        upd.Parameters.AddWithValue(JsonSerializer.Serialize(roleModules));
        await upd.ExecuteNonQueryAsync();
    }

    public async Task DeleteCustomRoleAsync(string key)
    {
        if (AuthConstants.BuiltinRoles.ContainsKey(key)) throw new InvalidOperationException("Нельзя удалить встроенную роль");
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("DELETE FROM vs_custom_roles WHERE key = $1", conn);
        cmd.Parameters.AddWithValue(key);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<bool> IsValidRoleAsync(string? role)
    {
        if (string.IsNullOrEmpty(role)) return false;
        if (AuthConstants.BuiltinRoles.ContainsKey(role)) return true;
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT 1 FROM vs_custom_roles WHERE key = $1", conn);
        cmd.Parameters.AddWithValue(role);
        return await cmd.ExecuteScalarAsync() != null;
    }

    public async Task<string> ResolveRoleAsync(string? role) => await IsValidRoleAsync(role) ? role! : "manager";

    public async Task<List<string>> GetModulesForRoleAsync(string? role)
    {
        if (role != null && AuthConstants.ModulesByRole.TryGetValue(role, out var m)) return m;
        var custom = await LoadCustomRolesAsync();
        if (role != null && custom.TryGetValue(role, out var c)) return c.Modules;
        return AuthConstants.ModulesByRole["manager"];
    }

    public async Task<List<string>> ResolveModulesAsync(string? role, List<string>? storedModules)
    {
        var roleDefaults = await GetModulesForRoleAsync(role);
        if (storedModules == null || storedModules.Count == 0) return roleDefaults;
        var filtered = storedModules.Where(m => AuthConstants.AllModules.Contains(m)).ToList();
        if (role != null && AuthConstants.PrivilegedRoles.Contains(role))
            return filtered.Union(roleDefaults).ToList();
        return filtered;
    }

    // ─── vs_users (Фаза 0) ───────────────────────────────────────────────────

    private static AuthVsUser RowToUser(NpgsqlDataReader r) => new()
    {
        Login = r.GetString(0),
        Name = r.IsDBNull(1) ? null : r.GetString(1),
        Role = r.IsDBNull(2) ? null : r.GetString(2),
        Modules = r.IsDBNull(3) ? null : ParseStringList(r.GetString(3)),
        Actions = r.IsDBNull(4) ? null : ParseStringList(r.GetString(4)),
        ShiftType = r.IsDBNull(5) ? null : r.GetString(5),
        CompanyIds = r.IsDBNull(6) ? null : ParseStringList(r.GetString(6)),
        VisibleCompanies = r.IsDBNull(7) ? null : ParseStringList(r.GetString(7)),
        AllowWithoutToken = !r.IsDBNull(8) && r.GetBoolean(8),
        SelfOnly = !r.IsDBNull(9) && r.GetBoolean(9),
        PasswordHash = r.IsDBNull(10) ? null : r.GetString(10),
        WmsPhone = r.IsDBNull(11) ? null : r.GetString(11),
        TelegramChatId = r.IsDBNull(12) ? null : r.GetString(12),
    };

    private const string UserColumns = "login, name, role, modules, actions, shift_type, company_ids, visible_companies, allow_without_token, self_only, password_hash, wms_phone, telegram_chat_id";

    public async Task<List<AuthVsUser>> LoadVsUsersAsync()
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand($"SELECT {UserColumns} FROM vs_users", conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        var list = new List<AuthVsUser>();
        while (await reader.ReadAsync()) list.Add(RowToUser(reader));
        return list;
    }

    private async Task PersistUserAsync(AuthVsUser u, NpgsqlConnection? existingConn = null)
    {
        var conn = existingConn ?? await OpenAsync();
        try
        {
            await using var cmd = new NpgsqlCommand(@"
                INSERT INTO vs_users (login, name, role, modules, actions, shift_type, company_ids, visible_companies, allow_without_token, self_only, password_hash, wms_phone, telegram_chat_id)
                VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
                ON CONFLICT (login) DO UPDATE SET
                  name = $2, role = $3, modules = $4::jsonb, actions = $5::jsonb, shift_type = $6, company_ids = $7::jsonb,
                  visible_companies = $8::jsonb, allow_without_token = $9, self_only = $10, password_hash = $11,
                  wms_phone = $12, telegram_chat_id = $13", conn);
            cmd.Parameters.AddWithValue(u.Login);
            cmd.Parameters.AddWithValue((object?)u.Name ?? DBNull.Value);
            cmd.Parameters.AddWithValue((object?)u.Role ?? DBNull.Value);
            cmd.Parameters.AddWithValue((object?)(u.Modules != null ? JsonSerializer.Serialize(u.Modules) : null) ?? DBNull.Value);
            cmd.Parameters.AddWithValue((object?)(u.Actions != null ? JsonSerializer.Serialize(u.Actions) : null) ?? DBNull.Value);
            cmd.Parameters.AddWithValue((object?)u.ShiftType ?? DBNull.Value);
            cmd.Parameters.AddWithValue((object?)(u.CompanyIds != null ? JsonSerializer.Serialize(u.CompanyIds) : null) ?? DBNull.Value);
            cmd.Parameters.AddWithValue((object?)(u.VisibleCompanies != null ? JsonSerializer.Serialize(u.VisibleCompanies) : null) ?? DBNull.Value);
            cmd.Parameters.AddWithValue(u.AllowWithoutToken);
            cmd.Parameters.AddWithValue(u.SelfOnly);
            cmd.Parameters.AddWithValue((object?)u.PasswordHash ?? DBNull.Value);
            cmd.Parameters.AddWithValue((object?)u.WmsPhone ?? DBNull.Value);
            cmd.Parameters.AddWithValue((object?)u.TelegramChatId ?? DBNull.Value);
            await cmd.ExecuteNonQueryAsync();
        }
        finally
        {
            if (existingConn == null) await conn.DisposeAsync();
        }
    }

    public async Task<AuthVsUser?> FindUserByLoginAsync(string? login)
    {
        var trimmed = (login ?? "").Trim();
        var normalized = NormalizeLogin(login);
        var users = await LoadVsUsersAsync();
        foreach (var u in users)
        {
            bool match = !string.IsNullOrEmpty(u.PasswordHash)
                ? trimmed.ToLowerInvariant() == u.Login.Trim().ToLowerInvariant()
                : NormalizeLogin(u.Login) is var uLogin && !string.IsNullOrEmpty(uLogin) && (uLogin == normalized || u.Login == login);
            if (!match) continue;

            var role = await ResolveRoleAsync(u.Role);
            var modules = await ResolveModulesAsync(role, u.Modules);
            var actions = u.Actions != null ? u.Actions.Where(a => AuthConstants.AllActions.Contains(a)).ToList() : AuthConstants.GetActionsForRole(role);
            return new AuthVsUser
            {
                Login = u.Login,
                Name = u.Name,
                Role = role,
                ShiftType = u.ShiftType is "day" or "night" ? u.ShiftType : null,
                CompanyIds = u.CompanyIds is { Count: > 0 } ? u.CompanyIds : null,
                VisibleCompanies = u.VisibleCompanies is { Count: > 0 } ? u.VisibleCompanies : null,
                Modules = modules,
                Actions = actions,
                AllowWithoutToken = u.AllowWithoutToken,
                SelfOnly = u.SelfOnly,
                PasswordHash = u.PasswordHash,
            };
        }
        return null;
    }

    public async Task<List<Dictionary<string, object?>>> GetAllUsersForAdminAsync()
    {
        var users = await LoadVsUsersAsync();
        var logins = await LoadLoginsAsync();
        var byLogin = new Dictionary<string, Dictionary<string, object?>>();
        foreach (var u in users)
        {
            var login = u.Login.Trim();
            if (login == "") continue;
            var role = await ResolveRoleAsync(u.Role);
            var modules = await ResolveModulesAsync(role, u.Modules);
            var loginKey = IsLetterLogin(login) ? login : (CanonicalPhone(login) ?? login);
            logins.TryGetValue(loginKey, out var rec);
            rec ??= logins.GetValueOrDefault(login);
            var actions = u.Actions != null ? u.Actions.Where(a => AuthConstants.AllActions.Contains(a)).ToList() : AuthConstants.GetActionsForRole(role);
            byLogin[login] = new Dictionary<string, object?>
            {
                ["login"] = login,
                ["name"] = u.Name,
                ["role"] = role,
                ["shiftType"] = u.ShiftType is "day" or "night" ? u.ShiftType : null,
                ["companyIds"] = u.CompanyIds is { Count: > 0 } ? u.CompanyIds : null,
                ["visibleCompanies"] = u.VisibleCompanies is { Count: > 0 } ? u.VisibleCompanies : null,
                ["modules"] = modules,
                ["actions"] = actions,
                ["allowWithoutToken"] = u.AllowWithoutToken,
                ["selfOnly"] = u.SelfOnly,
                ["hasPassword"] = !string.IsNullOrEmpty(u.PasswordHash),
                ["lastAttemptAt"] = rec?.LastAttemptAt,
                ["lastSuccessAt"] = rec?.LastSuccessAt,
                ["hasAccess"] = true,
            };
        }
        foreach (var (login, rec) in logins)
        {
            if (byLogin.ContainsKey(login)) continue;
            byLogin[login] = new Dictionary<string, object?>
            {
                ["login"] = login,
                ["role"] = null,
                ["shiftType"] = null,
                ["companyIds"] = null,
                ["modules"] = new List<string>(),
                ["lastAttemptAt"] = rec.LastAttemptAt,
                ["lastSuccessAt"] = rec.LastSuccessAt,
                ["hasAccess"] = false,
            };
        }
        return byLogin.Values.OrderBy(v => (string?)v["login"] ?? "", StringComparer.Ordinal).ToList();
    }

    public class SaveUserPayload
    {
        public string? Name { get; set; }
        public string? Role { get; set; }
        public List<string>? Modules { get; set; }
        public List<string>? Actions { get; set; }
        public string? ShiftType { get; set; }
        public List<string>? CompanyIds { get; set; }
        public List<string>? VisibleCompanies { get; set; }
        public bool? AllowWithoutToken { get; set; }
        public bool? SelfOnly { get; set; }
        public string? Password { get; set; }
        public bool NameSet, RoleSet, ModulesSet, ActionsSet, ShiftTypeSet, CompanyIdsSet, VisibleCompaniesSet, AllowWithoutTokenSet, SelfOnlySet, PasswordSet;
    }

    public async Task SaveUserAsync(string login, SaveUserPayload payload)
    {
        var trimmedLogin = login.Trim();
        if (trimmedLogin == "") throw new InvalidOperationException("Логин не указан");
        var loginToStore = IsLetterLogin(trimmedLogin) ? trimmedLogin : (CanonicalPhone(trimmedLogin) ?? trimmedLogin);
        var normalized = NormalizeLogin(login);
        var users = await LoadVsUsersAsync();
        var existing = users.FirstOrDefault(u => UserLoginMatch(u, login, normalized, trimmedLogin));

        AuthVsUser changed;
        if (existing != null)
        {
            var u = existing;
            if (payload.NameSet) u.Name = string.IsNullOrEmpty((payload.Name ?? "").Trim()) ? null : payload.Name!.Trim();
            if (payload.RoleSet) u.Role = await ResolveRoleAsync(payload.Role);
            if (payload.ModulesSet) u.Modules = payload.Modules?.Where(m => AuthConstants.AllModules.Contains(m)).ToList();
            if (payload.ShiftTypeSet) u.ShiftType = payload.ShiftType is "day" or "night" ? payload.ShiftType : null;
            if (payload.CompanyIdsSet) u.CompanyIds = payload.CompanyIds;
            if (payload.VisibleCompaniesSet) u.VisibleCompanies = payload.VisibleCompanies is { Count: > 0 } ? payload.VisibleCompanies : null;
            if (payload.AllowWithoutTokenSet) u.AllowWithoutToken = payload.AllowWithoutToken == true;
            if (payload.SelfOnlySet) u.SelfOnly = payload.SelfOnly == true;
            if (payload.ActionsSet) u.Actions = payload.Actions?.Where(a => AuthConstants.AllActions.Contains(a)).ToList();
            if (payload.PasswordSet && !string.IsNullOrEmpty((payload.Password ?? "").Trim()))
                u.PasswordHash = HashPassword(payload.Password!.Trim());
            changed = u;
        }
        else
        {
            var role = await ResolveRoleAsync(payload.Role);
            var modules = payload.Modules?.Where(m => AuthConstants.AllModules.Contains(m)).ToList();
            changed = new AuthVsUser
            {
                Login = loginToStore,
                Name = string.IsNullOrEmpty((payload.Name ?? "").Trim()) ? null : payload.Name!.Trim(),
                Role = role,
                ShiftType = payload.ShiftType is "day" or "night" ? payload.ShiftType : null,
                CompanyIds = payload.CompanyIds,
                VisibleCompanies = payload.VisibleCompanies is { Count: > 0 } ? payload.VisibleCompanies : null,
                Modules = modules is { Count: > 0 } ? modules : null,
                Actions = payload.Actions?.Where(a => AuthConstants.AllActions.Contains(a)).ToList(),
                AllowWithoutToken = payload.AllowWithoutToken == true,
                SelfOnly = payload.SelfOnly == true,
            };
            if (payload.PasswordSet && !string.IsNullOrEmpty((payload.Password ?? "").Trim()))
                changed.PasswordHash = HashPassword(payload.Password!.Trim());
        }
        await PersistUserAsync(changed);
    }

    public async Task RemoveUserAsync(string login)
    {
        var trimmed = login.Trim();
        var normalized = NormalizeLogin(login);
        var users = await LoadVsUsersAsync();
        var toRemove = users.Where(u => UserLoginMatch(u, login, normalized, trimmed)).ToList();
        await using var conn = await OpenAsync();
        foreach (var u in toRemove)
        {
            await using var cmd = new NpgsqlCommand("DELETE FROM vs_users WHERE login = $1", conn);
            cmd.Parameters.AddWithValue(u.Login);
            await cmd.ExecuteNonQueryAsync();
        }
    }

    // ─── vs_logins (Фаза 4) ──────────────────────────────────────────────────

    public async Task<Dictionary<string, LoginRecord>> LoadLoginsAsync()
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT login_key, last_attempt_at, last_success_at FROM vs_logins", conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        var logins = new Dictionary<string, LoginRecord>();
        while (await reader.ReadAsync())
        {
            logins[reader.GetString(0)] = new LoginRecord
            {
                LastAttemptAt = reader.IsDBNull(1) ? null : reader.GetDateTime(1).ToUniversalTime().ToString("o"),
                LastSuccessAt = reader.IsDBNull(2) ? null : reader.GetDateTime(2).ToUniversalTime().ToString("o"),
            };
        }
        return logins;
    }

    public async Task RecordLoginAttemptAsync(string? login, bool success)
    {
        var raw = (login ?? "").Trim();
        var key = IsLetterLogin(raw) ? raw : (CanonicalPhone(raw) ?? (raw != "" ? raw : "unknown"));
        var now = DateTime.UtcNow;
        await using var conn = await OpenAsync();
        if (success)
        {
            await using var cmd = new NpgsqlCommand(
                "INSERT INTO vs_logins (login_key, last_attempt_at, last_success_at) VALUES ($1, $2, $2) ON CONFLICT (login_key) DO UPDATE SET last_attempt_at = $2, last_success_at = $2", conn);
            cmd.Parameters.AddWithValue(key);
            cmd.Parameters.AddWithValue(now);
            await cmd.ExecuteNonQueryAsync();
        }
        else
        {
            await using var cmd = new NpgsqlCommand(
                "INSERT INTO vs_logins (login_key, last_attempt_at) VALUES ($1, $2) ON CONFLICT (login_key) DO UPDATE SET last_attempt_at = $2", conn);
            cmd.Parameters.AddWithValue(key);
            cmd.Parameters.AddWithValue(now);
            await cmd.ExecuteNonQueryAsync();
        }
    }

    // ─── vs_pending_users (Фаза 4) ───────────────────────────────────────────

    private static PendingUser RowToPending(NpgsqlDataReader r) => new()
    {
        Name = r.IsDBNull(0) ? "" : r.GetString(0),
        Phone = r.GetString(1),
        WmsPhone = r.IsDBNull(2) ? "" : r.GetString(2),
        SitePasswordHash = r.IsDBNull(3) ? null : r.GetString(3),
        RegisteredAt = r.GetDateTime(4).ToUniversalTime().ToString("o"),
        Status = r.IsDBNull(5) ? "pending" : r.GetString(5),
    };

    private const string PendingColumns = "name, phone, wms_phone, site_password_hash, registered_at, status";

    public async Task AddPendingUserAsync(string name, string phone, string wmsPhone, string sitePasswordHash)
    {
        var normalized = NormalizePhone(phone);
        if (normalized == "") throw new InvalidOperationException("Некорректный номер телефона");
        var users = await LoadVsUsersAsync();
        if (users.Any(u => NormalizePhone(u.Login) == normalized))
            throw new InvalidOperationException("Пользователь с таким номером уже существует");

        await using var conn = await OpenAsync();
        await using var checkCmd = new NpgsqlCommand("SELECT 1 FROM vs_pending_users WHERE normalized_phone = $1", conn);
        checkCmd.Parameters.AddWithValue(normalized);
        if (await checkCmd.ExecuteScalarAsync() != null)
            throw new InvalidOperationException("Заявка от этого номера уже ожидает рассмотрения");

        await using var cmd = new NpgsqlCommand(
            "INSERT INTO vs_pending_users (name, phone, wms_phone, site_password_hash, normalized_phone) VALUES ($1, $2, $3, $4, $5)", conn);
        cmd.Parameters.AddWithValue(name.Trim());
        cmd.Parameters.AddWithValue("+7" + normalized);
        cmd.Parameters.AddWithValue(Regex.Replace(string.IsNullOrEmpty(wmsPhone) ? phone : wmsPhone, @"\D", ""));
        cmd.Parameters.AddWithValue((object?)sitePasswordHash ?? DBNull.Value);
        cmd.Parameters.AddWithValue(normalized);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<List<PendingUser>> GetPendingUsersAsync()
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand($"SELECT {PendingColumns} FROM vs_pending_users ORDER BY registered_at", conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        var list = new List<PendingUser>();
        while (await reader.ReadAsync()) list.Add(RowToPending(reader));
        return list;
    }

    public async Task ApprovePendingUserAsync(string phone, string? role, List<string>? modules)
    {
        var normalized = NormalizePhone(phone);
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand($"SELECT {PendingColumns} FROM vs_pending_users WHERE normalized_phone = $1", conn);
        cmd.Parameters.AddWithValue(normalized);
        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) throw new InvalidOperationException("Заявка не найдена");
        var entry = RowToPending(reader);
        await reader.CloseAsync();

        var validRole = await ResolveRoleAsync(role);
        var newUser = new AuthVsUser
        {
            Login = CanonicalPhone(entry.Phone) ?? entry.Phone,
            Name = entry.Name != "" ? entry.Name : null,
            Role = validRole,
            Modules = modules is { Count: > 0 } ? modules.Where(m => AuthConstants.AllModules.Contains(m)).ToList() : null,
            AllowWithoutToken = false,
            PasswordHash = entry.SitePasswordHash,
            WmsPhone = entry.WmsPhone != "" ? entry.WmsPhone : null,
        };
        await PersistUserAsync(newUser, conn);
        await using var del = new NpgsqlCommand("DELETE FROM vs_pending_users WHERE normalized_phone = $1", conn);
        del.Parameters.AddWithValue(normalized);
        await del.ExecuteNonQueryAsync();
    }

    public async Task RejectPendingUserAsync(string phone)
    {
        var normalized = NormalizePhone(phone);
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("DELETE FROM vs_pending_users WHERE normalized_phone = $1", conn);
        cmd.Parameters.AddWithValue(normalized);
        await cmd.ExecuteNonQueryAsync();
    }

    // ─── Сессии (vs_sessions, Фаза 0) — полная версия для login/me/logout ───

    private static string CreateSessionId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();

    public async Task<string> CreateSessionAsync(AuthVsUser user, string login)
    {
        var sid = CreateSessionId();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var modules = user.Modules is { Count: > 0 } ? user.Modules : await GetModulesForRoleAsync(user.Role);
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            INSERT INTO vs_sessions (session_id, login, role, name, shift_type, company_ids, modules, allow_without_token, self_only, created_at, last_active_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
            ON CONFLICT (session_id) DO UPDATE SET
              login = $2, role = $3, name = $4, shift_type = $5, company_ids = $6::jsonb, modules = $7::jsonb,
              allow_without_token = $8, self_only = $9, created_at = $10, last_active_at = $11", conn);
        cmd.Parameters.AddWithValue(sid);
        cmd.Parameters.AddWithValue(login);
        cmd.Parameters.AddWithValue((object?)user.Role ?? DBNull.Value);
        cmd.Parameters.AddWithValue((object?)user.Name ?? DBNull.Value);
        cmd.Parameters.AddWithValue((object?)user.ShiftType ?? DBNull.Value);
        cmd.Parameters.AddWithValue((object?)(user.CompanyIds != null ? JsonSerializer.Serialize(user.CompanyIds) : null) ?? DBNull.Value);
        cmd.Parameters.AddWithValue(JsonSerializer.Serialize(modules));
        cmd.Parameters.AddWithValue(user.AllowWithoutToken);
        cmd.Parameters.AddWithValue(user.SelfOnly);
        cmd.Parameters.AddWithValue(now);
        cmd.Parameters.AddWithValue(now);
        await cmd.ExecuteNonQueryAsync();
        return sid;
    }

    public async Task<AuthVsSession?> GetSessionAsync(string? sessionId)
    {
        if (string.IsNullOrEmpty(sessionId)) return null;
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "SELECT login, role, name, shift_type, company_ids, modules, allow_without_token, self_only, created_at, last_active_at FROM vs_sessions WHERE session_id = $1", conn);
        cmd.Parameters.AddWithValue(sessionId);
        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) return null;
        var session = new AuthVsSession
        {
            Login = reader.IsDBNull(0) ? "" : reader.GetString(0),
            Role = reader.IsDBNull(1) ? null : reader.GetString(1),
            Name = reader.IsDBNull(2) ? null : reader.GetString(2),
            ShiftType = reader.IsDBNull(3) ? null : reader.GetString(3),
            CompanyIds = reader.IsDBNull(4) ? null : ParseStringList(reader.GetString(4)),
            Modules = reader.IsDBNull(5) ? null : ParseStringList(reader.GetString(5)),
            AllowWithoutToken = !reader.IsDBNull(6) && reader.GetBoolean(6),
            SelfOnly = !reader.IsDBNull(7) && reader.GetBoolean(7),
            CreatedAt = reader.IsDBNull(8) ? 0 : reader.GetInt64(8),
            LastActiveAt = reader.IsDBNull(9) ? 0 : reader.GetInt64(9),
        };
        await reader.CloseAsync();

        var lastActive = session.LastActiveAt != 0 ? session.LastActiveAt : session.CreatedAt;
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (nowMs - lastActive > AuthConstants.SessionTtlMs)
        {
            await using var del = new NpgsqlCommand("DELETE FROM vs_sessions WHERE session_id = $1", conn);
            del.Parameters.AddWithValue(sessionId);
            await del.ExecuteNonQueryAsync();
            return null;
        }
        if (nowMs - lastActive > AuthConstants.SessionTouchMinIntervalMs)
        {
            await using var touch = new NpgsqlCommand("UPDATE vs_sessions SET last_active_at = $2 WHERE session_id = $1", conn);
            touch.Parameters.AddWithValue(sessionId);
            touch.Parameters.AddWithValue(nowMs);
            await touch.ExecuteNonQueryAsync();
            session.LastActiveAt = nowMs;
        }
        return session;
    }

    public async Task DestroySessionAsync(string? sessionId)
    {
        if (string.IsNullOrEmpty(sessionId)) return;
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("DELETE FROM vs_sessions WHERE session_id = $1", conn);
        cmd.Parameters.AddWithValue(sessionId);
        await cmd.ExecuteNonQueryAsync();
    }

    // ─── Samokat WMS API (внешний HTTP) ──────────────────────────────────────

    private static readonly HttpClient _http = new();

    public async Task<SamokatLoginResult> SamokatLoginAsync(string login, string password)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, AuthConstants.SamokatAuthUrl);
        req.Headers.Add("Accept", "application/json");
        req.Headers.Add("Origin", "https://wwh.samokat.ru");
        req.Headers.Add("Referer", "https://wwh.samokat.ru/");
        req.Content = new StringContent(JsonSerializer.Serialize(new { login, password }), Encoding.UTF8, "application/json");
        var res = await _http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
        {
            var message = $"Ошибка авторизации Samokat: {(int)res.StatusCode}";
            try
            {
                using var doc = JsonDocument.Parse(text);
                if (doc.RootElement.TryGetProperty("message", out var m)) message = m.GetString() ?? message;
            }
            catch { /* тело не JSON — оставляем дефолтное сообщение */ }
            throw new SamokatAuthException(message, (int)res.StatusCode);
        }
        using var okDoc = JsonDocument.Parse(text);
        var value = okDoc.RootElement.TryGetProperty("value", out var v) ? v : default;
        return new SamokatLoginResult
        {
            AccessToken = value.ValueKind == JsonValueKind.Object && value.TryGetProperty("accessToken", out var at) ? at.GetString() : null,
            RefreshToken = value.ValueKind == JsonValueKind.Object && value.TryGetProperty("refreshToken", out var rt) ? rt.GetString() : null,
            ExpiresIn = value.ValueKind == JsonValueKind.Object && value.TryGetProperty("expiresIn", out var ei) && ei.TryGetInt32(out var eiVal) ? eiVal : 300,
        };
    }

    private static List<string>? ParseStringList(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return JsonSerializer.Deserialize<List<string>>(json); }
        catch { return null; }
    }
}

public class SamokatAuthException : Exception
{
    public int Status { get; }
    public SamokatAuthException(string message, int status) : base(message) => Status = status;
}
