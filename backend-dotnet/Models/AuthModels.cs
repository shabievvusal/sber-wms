namespace BackendDotnet.Models;

// Порт vs_users (полная строка, шире SessionService.VsUser, который читает
// только поля, нужные для гейтинга других доменов).
public class AuthVsUser
{
    public string Login { get; set; } = "";
    public string? Name { get; set; }
    public string? Role { get; set; }
    public List<string>? Modules { get; set; }
    public List<string>? Actions { get; set; }
    public string? ShiftType { get; set; }
    public List<string>? CompanyIds { get; set; }
    public List<string>? VisibleCompanies { get; set; }
    public bool AllowWithoutToken { get; set; }
    public bool SelfOnly { get; set; }
    public string? PasswordHash { get; set; }
    public string? WmsPhone { get; set; }
    public string? TelegramChatId { get; set; }
}

// Полная сессия (vs_sessions) — шире SessionService.VsSession, включает
// Modules/Name/AllowWithoutToken/SelfOnly, нужные /api/vs/auth/me.
public class AuthVsSession
{
    public string Login { get; set; } = "";
    public string? Role { get; set; }
    public string? Name { get; set; }
    public string? ShiftType { get; set; }
    public List<string>? CompanyIds { get; set; }
    public List<string>? Modules { get; set; }
    public bool AllowWithoutToken { get; set; }
    public bool SelfOnly { get; set; }
    public long CreatedAt { get; set; }
    public long LastActiveAt { get; set; }
}

public class CustomRole
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public List<string> Modules { get; set; } = new();
}

public class RoleDto
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public List<string> Modules { get; set; } = new();
    public bool Builtin { get; set; }
}

public class PendingUser
{
    public string Name { get; set; } = "";
    public string Phone { get; set; } = "";
    public string WmsPhone { get; set; } = "";
    public string? SitePasswordHash { get; set; }
    public string RegisteredAt { get; set; } = "";
    public string Status { get; set; } = "pending";
}

public class LoginRecord
{
    public string? LastAttemptAt { get; set; }
    public string? LastSuccessAt { get; set; }
}

// Порт результата samokatLogin() — только поля, реально используемые.
public class SamokatLoginResult
{
    public string? AccessToken { get; set; }
    public string? RefreshToken { get; set; }
    public int ExpiresIn { get; set; } = 300;
}

// Ключи ролей/модулей/действий — скопированы 1-в-1 из vs-auth-pg.js.
public static class AuthConstants
{
    public const string SamokatAuthUrl = "https://api.samokat.ru/wmsin-wwh/auth/password";
    public const string SessionCookieName = "vs_sid";
    public const long SessionTtlMs = 30L * 24 * 60 * 60 * 1000;
    public const long SessionTouchMinIntervalMs = 60 * 1000;

    public static readonly List<string> AllModules = new()
    {
        "stats", "data", "monitor", "analysis", "consolidation", "docs", "settings",
        "shipments", "receive", "consolidation_form", "reports", "supplies", "picking",
        "shift_plan", "tsd", "violations",
    };

    public static readonly List<string> AllActions = new() { "fetch_data", "recheck_data", "request_fetch", "edit_thresholds" };

    public static readonly List<string> PrivilegedRoles = new() { "admin", "developer" };

    public static readonly Dictionary<string, List<string>> ModulesByRole = new()
    {
        ["admin"] = new() { "stats", "data", "monitor", "analysis", "consolidation", "docs", "settings", "shipments", "receive", "consolidation_form", "reports", "supplies", "picking", "shift_plan", "tsd", "violations" },
        ["group_leader"] = new() { "stats", "data", "monitor", "analysis", "consolidation", "docs", "settings", "shipments", "receive", "consolidation_form", "reports", "picking", "shift_plan", "tsd", "violations" },
        ["supervisor"] = new() { "stats", "data", "monitor", "analysis", "docs", "shipments", "reports", "picking", "shift_plan", "tsd" },
        ["manager"] = new() { "stats", "data", "monitor", "analysis", "docs", "shipments", "reports", "picking", "shift_plan", "tsd" },
        ["developer"] = new() { "stats", "data", "monitor", "analysis", "consolidation", "docs", "settings", "shipments", "receive", "consolidation_form", "reports", "supplies", "picking", "shift_plan", "tsd", "violations" },
    };

    public static readonly Dictionary<string, List<string>> ActionsByRole = new()
    {
        ["admin"] = new() { "fetch_data", "recheck_data", "request_fetch", "edit_thresholds" },
        ["group_leader"] = new() { "fetch_data", "recheck_data", "request_fetch", "edit_thresholds" },
        ["supervisor"] = new() { "fetch_data", "recheck_data", "request_fetch" },
        ["manager"] = new(),
        ["developer"] = new() { "fetch_data", "recheck_data", "request_fetch", "edit_thresholds" },
    };

    public static readonly Dictionary<string, string> BuiltinRoles = new()
    {
        ["admin"] = "Администратор",
        ["group_leader"] = "Руководитель группы",
        ["supervisor"] = "Начальник смены",
        ["manager"] = "Менеджер",
    };

    public static List<string> GetActionsForRole(string? role) =>
        role != null && ActionsByRole.TryGetValue(role, out var a) ? a : new List<string>();
}
