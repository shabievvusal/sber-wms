using System.Text;
using System.Text.Json;
using Npgsql;

namespace BackendDotnet.Services;

// Проверка учётных записей сотрудников для входа в ТСД (WMS): по телефону и
// паролю из списка сотрудников выполняется вход в API терминала
// (wmsin-pdt/auth/password) — так же, как это делает сам ТСД. Результат
// (работает / не пускает / ошибка WMS / не удалось проверить / нет данных)
// хранится в employee_account_checks — по нему строится колонка «Учётка» в
// списке сотрудников и отчёт для аутсорсинговых компаний.
//
// skipCheckingSession=true — как в запросе самого ТСД: вход не завершает
// сессию человека, который сейчас работает на терминале.
// Полученные токены нигде не сохраняются и сразу отбрасываются.
public class AccountCheckService
{
    // адрес можно переопределить (WMS_PDT_AUTH_URL) — для проверки на тестовом стенде
    private static readonly string PdtAuthUrl =
        Environment.GetEnvironmentVariable("WMS_PDT_AUTH_URL") is { Length: > 0 } url ? url : "https://api.samokat.ru/wmsin-pdt/auth/password";
    // ID «устройства» ТСД — то же значение, что использует Node (WMS_PDT_USER_AGENT)
    private static readonly string PdtUserAgent =
        Environment.GetEnvironmentVariable("WMS_PDT_USER_AGENT") is { Length: > 0 } ua ? ua : "1686f906-cccc-4caf-9dbd-fd8a2908d17a";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private static volatile bool _tableReady;

    private readonly string _connectionString;
    private readonly IHttpContextAccessor _http;

    public AccountCheckService(IConfiguration config, IHttpContextAccessor http)
    {
        _connectionString = config.GetConnectionString("Postgres")!;
        _http = http;
    }

    // склад запроса — результаты проверок и сотрудники у каждого склада свои
    private string Warehouse => BackendDotnet.Data.WarehouseContext.Current(_http.HttpContext);

    public static class Status
    {
        public const string Ok = "ok";                     // вход проходит
        public const string AuthFailed = "auth_failed";    // AUTHENTICATION_ERROR: неверный пароль / учётка заблокирована
        public const string WmsError = "wms_error";        // WMS вернул другую ошибку — код сохраняется как есть
        public const string Unavailable = "unavailable";   // WMS не ответил / сеть — проверить не удалось (это не проблема учётки)
        public const string NoCredentials = "no_credentials"; // нет телефона/пароля или телефон неправильного формата
    }

    public record CheckResult(string ExecutorId, string Status, string? Code, string? Message, long CheckedAt);

    private async Task<NpgsqlConnection> OpenAsync()
    {
        var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync();
        if (!_tableReady)
        {
            await using var cmd = new NpgsqlCommand($@"
                CREATE TABLE IF NOT EXISTS employee_account_checks (
                    warehouse_id TEXT NOT NULL DEFAULT '{WarehouseService.DefaultWarehouseId}',
                    executor_id TEXT NOT NULL,
                    status      TEXT NOT NULL,
                    error_code  TEXT,
                    message     TEXT,
                    checked_at  BIGINT NOT NULL,
                    PRIMARY KEY (warehouse_id, executor_id)
                )", conn);
            await cmd.ExecuteNonQueryAsync();
            _tableReady = true;
        }
        return conn;
    }

    /// <summary>Логин для WMS: 11 цифр, начиная с 7 (как в запросе ТСД: "79213185040").</summary>
    public static string? NormalizeLogin(string? phone)
    {
        var d = new string((phone ?? "").Where(char.IsDigit).ToArray());
        if (d.Length == 10) d = "7" + d;
        else if (d.Length == 11 && d[0] == '8') d = "7" + d[1..];
        return d.Length == 11 && d[0] == '7' ? d : null;
    }

    public async Task<List<CheckResult>> ListAsync()
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT executor_id, status, error_code, message, checked_at FROM employee_account_checks WHERE warehouse_id = $1", conn);
        cmd.Parameters.AddWithValue(Warehouse);
        await using var r = await cmd.ExecuteReaderAsync();
        var list = new List<CheckResult>();
        while (await r.ReadAsync())
            list.Add(new CheckResult(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3), r.GetInt64(4)));
        return list;
    }

    /// <summary>Проверяет учётки по очереди (с паузой, чтобы не долбить WMS) и сохраняет результаты.</summary>
    public async Task<List<CheckResult>> CheckAsync(IReadOnlyList<string> executorIds, CancellationToken ct)
    {
        var results = new List<CheckResult>();
        if (executorIds.Count == 0) return results;
        var wh = Warehouse; // склад запроса — запоминаем сразу: проверка идёт долго

        await using var conn = await OpenAsync();
        var creds = new Dictionary<string, (string Phone, string Password)>();
        await using (var cmd = new NpgsqlCommand("SELECT executor_id, COALESCE(phone, ''), COALESCE(password, '') FROM employees WHERE executor_id = ANY($1) AND warehouse_id = $2", conn))
        {
            cmd.Parameters.AddWithValue(executorIds.ToArray());
            cmd.Parameters.AddWithValue(wh);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) creds[r.GetString(0)] = (r.GetString(1), r.GetString(2));
        }

        var first = true;
        foreach (var id in executorIds)
        {
            if (ct.IsCancellationRequested) break;
            CheckResult result;
            if (!creds.TryGetValue(id, out var c))
            {
                continue; // такого сотрудника нет в списке — пропускаем
            }
            var login = NormalizeLogin(c.Phone);
            if (string.IsNullOrWhiteSpace(c.Phone) || string.IsNullOrWhiteSpace(c.Password))
            {
                result = new CheckResult(id, Status.NoCredentials, null,
                    string.IsNullOrWhiteSpace(c.Phone) && string.IsNullOrWhiteSpace(c.Password) ? "Не указаны телефон и пароль"
                    : string.IsNullOrWhiteSpace(c.Phone) ? "Не указан телефон" : "Не указан пароль", Now());
            }
            else if (login == null)
            {
                result = new CheckResult(id, Status.NoCredentials, null, $"Неверный формат телефона: {c.Phone}", Now());
            }
            else
            {
                if (!first) await Task.Delay(300, ct); // небольшая пауза между входами
                first = false;
                result = await TryLoginAsync(id, login, c.Password.Trim(), ct);
            }
            await SaveAsync(conn, result, wh);
            results.Add(result);
        }
        return results;
    }

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static async Task<CheckResult> TryLoginAsync(string id, string login, string password, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, PdtAuthUrl);
            req.Headers.TryAddWithoutValidation("Accept", "application/json, text/plain, */*");
            req.Headers.TryAddWithoutValidation("User-Agent", PdtUserAgent);
            req.Content = new StringContent(
                JsonSerializer.Serialize(new { login, password, skipCheckingSession = true }), Encoding.UTF8, "application/json");
            using var res = await Http.SendAsync(req, ct);
            var text = await res.Content.ReadAsStringAsync(ct);

            JsonElement root = default;
            var parsed = false;
            try { using var doc = JsonDocument.Parse(text); root = doc.RootElement.Clone(); parsed = true; } catch { /* не JSON */ }

            // Успех: { value: { accessToken, refreshToken, expiresIn } } — токены не сохраняем
            if (parsed && root.ValueKind == JsonValueKind.Object &&
                root.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.Object &&
                v.TryGetProperty("accessToken", out var at) && at.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(at.GetString()))
                return new CheckResult(id, Status.Ok, null, null, Now());

            // Ошибка входа приходит с HTTP 200: { error: "AUTHENTICATION_ERROR", errorDetails: "…" }
            if (parsed && root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String)
            {
                var code = e.GetString() ?? "";
                var details = root.TryGetProperty("errorDetails", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
                if (code == "AUTHENTICATION_ERROR")
                    return new CheckResult(id, Status.AuthFailed, code, "Вход не проходит: неверный пароль или учётная запись заблокирована", Now());
                return new CheckResult(id, Status.WmsError, code, details != null && details != code ? details : null, Now());
            }

            if (!res.IsSuccessStatusCode)
                return new CheckResult(id, Status.Unavailable, $"HTTP {(int)res.StatusCode}", "WMS не ответил на проверку", Now());
            return new CheckResult(id, Status.Unavailable, null, "Непонятный ответ WMS", Now());
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            return new CheckResult(id, Status.Unavailable, null, ex is TaskCanceledException ? "WMS не ответил вовремя" : "Нет связи с WMS: " + ex.Message, Now());
        }
    }

    private static async Task SaveAsync(NpgsqlConnection conn, CheckResult r, string warehouse)
    {
        await using var cmd = new NpgsqlCommand(@"
            INSERT INTO employee_account_checks (executor_id, status, error_code, message, checked_at, warehouse_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (warehouse_id, executor_id) DO UPDATE SET status = $2, error_code = $3, message = $4, checked_at = $5", conn);
        cmd.Parameters.AddWithValue(r.ExecutorId);
        cmd.Parameters.AddWithValue(r.Status);
        cmd.Parameters.AddWithValue((object?)r.Code ?? DBNull.Value);
        cmd.Parameters.AddWithValue((object?)r.Message ?? DBNull.Value);
        cmd.Parameters.AddWithValue(r.CheckedAt);
        cmd.Parameters.AddWithValue(warehouse);
        await cmd.ExecuteNonQueryAsync();
    }
}
