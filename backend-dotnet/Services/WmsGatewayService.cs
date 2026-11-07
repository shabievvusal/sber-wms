using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace BackendDotnet.Services;

// Шлюз WMS: сотрудник без своего доступа к WMS делает запрос на сайте, сервер
// кладёт его в очередь склада, шлюз забирает запрос, выполняет его в WMS своим
// токеном и возвращает ответ. Сервер ждёт ответа и отдаёт его сотруднику.
//
// Шлюз — любая открытая вкладка сайта, где у человека своя живая сессия WMS
// (lib/wms/gatewayHost.js): шлюзов у склада может быть несколько, запрос берёт
// первый свободный. Первая версия: «ПК-шлюз — вкладка сайта «Шлюз WMS» на
// компьютере, где открыта WMS под учёткой с доступом», запускал разработчик.
//
// Очередь и состояние шлюзов — в памяти процесса (один экземпляр dotnet), после
// перезапуска шлюзы сами переподключаются за секунды. Кто может пользоваться
// шлюзом — таблица wms_gateway_access (одобряет только разработчик), журнал
// запросов — wms_gateway_log (см. WmsGatewayEndpoints).
public class WmsGatewayService
{
    public record Job(string Id, string Method, string Url, string? Body, string Login, string WarehouseId)
    {
        public TaskCompletionSource<(int Status, string Body)> Result { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public DateTime CreatedAt { get; } = DateTime.UtcNow;
        // логин шлюза, который выполнил запрос (для журнала)
        public string? HostLogin { get; set; }
    }

    public record GatewayInfo(string Login, DateTime LastSeen, int Done, int Failed);

    // Задание целиком (выгрузка статистики) идёт минутами — сотрудник не держит
    // открытый запрос (браузер телефона обрывает его примерно через минуту
    // тишины), а получает номер задания и спрашивает, готово ли.
    public class TaskState
    {
        public string Id { get; init; } = "";
        public string Login { get; init; } = "";
        public string Status { get; set; } = "queued"; // queued → running → done
        public string? Host { get; set; }               // логин шлюза, который выполняет
        public DateTime? StartedAt { get; set; }
        public int Code { get; set; }
        public string? Body { get; set; }
        public DateTime CreatedAt { get; } = DateTime.UtcNow;
    }
    private readonly ConcurrentDictionary<string, TaskState> _tasks = new();

    public TaskState AddTask(string id, string login)
    {
        // старые задания (час и больше) — убираем
        foreach (var kv in _tasks) if (DateTime.UtcNow - kv.Value.CreatedAt > TimeSpan.FromHours(1)) _tasks.TryRemove(kv.Key, out _);
        return _tasks[id] = new TaskState { Id = id, Login = login };
    }
    public TaskState? GetTask(string id) => _tasks.TryGetValue(id, out var t) ? t : null;
    public record GatewaySummary(int Online, DateTime? LastSeen, int Done, int Failed, List<GatewayInfo> Hosts);

    private readonly ConcurrentDictionary<string, ConcurrentQueue<Job>> _queues = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _signals = new();
    private readonly ConcurrentDictionary<string, Job> _inFlight = new();
    // запрос → логин шлюза, который его взял (ответ принимается только от него)
    private readonly ConcurrentDictionary<string, string> _takenBy = new();
    // склад → (логин шлюза → состояние)
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, GatewayInfo>> _gateways = new();

    // шлюз опрашивает сервер долгим запросом раз в ≤25 с — дольше 40 с тишины = не в сети
    public static readonly TimeSpan OnlineWindow = TimeSpan.FromSeconds(40);

    private SemaphoreSlim Signal(string wh) => _signals.GetOrAdd(wh, _ => new SemaphoreSlim(0));
    private ConcurrentQueue<Job> Queue(string wh) => _queues.GetOrAdd(wh, _ => new ConcurrentQueue<Job>());
    private ConcurrentDictionary<string, GatewayInfo> Hosts(string wh) => _gateways.GetOrAdd(wh, _ => new());

    public GatewaySummary Gateway(string wh)
    {
        var now = DateTime.UtcNow;
        var hosts = Hosts(wh).Values.OrderByDescending(h => h.LastSeen).ToList();
        return new GatewaySummary(
            hosts.Count(h => now - h.LastSeen < OnlineWindow),
            hosts.Count > 0 ? hosts[0].LastSeen : null,
            hosts.Sum(h => h.Done), hosts.Sum(h => h.Failed), hosts);
    }

    public bool IsOnline(string wh) => Gateway(wh).Online > 0;
    public int QueueLength(string wh) => _queues.TryGetValue(wh, out var q) ? q.Count : 0;

    public void Touch(string wh, string login) =>
        Hosts(wh).AddOrUpdate(login, _ => new GatewayInfo(login, DateTime.UtcNow, 0, 0), (_, g) => g with { LastSeen = DateTime.UtcNow });

    private void Count(string wh, string login, bool ok) =>
        Hosts(wh).AddOrUpdate(login, _ => new GatewayInfo(login, DateTime.UtcNow, ok ? 1 : 0, ok ? 0 : 1),
            (_, g) => g with { Done = g.Done + (ok ? 1 : 0), Failed = g.Failed + (ok ? 0 : 1) });

    /// <summary>Поставить запрос в очередь склада и ждать ответа шлюза.</summary>
    public async Task<(int Status, string Body)?> RunAsync(Job job, TimeSpan timeout, CancellationToken ct)
    {
        Queue(job.WarehouseId).Enqueue(job);
        Signal(job.WarehouseId).Release();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            return await job.Result.Task.WaitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            // не дождались — шлюз, если возьмёт его позже, просто выбросит ответ
            job.Result.TrySetCanceled();
            return null;
        }
        finally
        {
            _inFlight.TryRemove(job.Id, out _);
            _takenBy.TryRemove(job.Id, out _);
        }
    }

    /// <summary>Долгий опрос шлюза: следующий запрос склада или null через wait.</summary>
    public async Task<Job?> NextAsync(string wh, string login, TimeSpan wait, CancellationToken ct)
    {
        Touch(wh, login);
        var deadline = DateTime.UtcNow + wait;
        while (!ct.IsCancellationRequested)
        {
            while (Queue(wh).TryDequeue(out var job))
            {
                // запрос, который уже никто не ждёт (ушёл по таймауту), не выполняем
                if (job.Result.Task.IsCompleted) continue;
                _inFlight[job.Id] = job;
                _takenBy[job.Id] = login;
                job.HostLogin = login;
                if (_tasks.TryGetValue(job.Id, out var task)) { task.Status = "running"; task.Host = login; task.StartedAt = DateTime.UtcNow; }
                return job;
            }
            var left = deadline - DateTime.UtcNow;
            if (left <= TimeSpan.Zero) return null;
            try { await Signal(wh).WaitAsync(left, ct); } catch (OperationCanceledException) { return null; }
            Touch(wh, login);
        }
        return null;
    }

    /// <summary>Ответ шлюза; принимается только от того, кто взял запрос.
    /// status 0 — шлюз не достучался до WMS по сети: запрос уходит обратно в
    /// очередь, его возьмёт другой шлюз.</summary>
    public bool Complete(string jobId, string wh, string login, int status, string body)
    {
        if (!_takenBy.TryGetValue(jobId, out var taker) || taker != login) return false;
        if (!_inFlight.TryRemove(jobId, out var job) || job.WarehouseId != wh) return false;
        _takenBy.TryRemove(jobId, out _);
        if (status == 0)
        {
            // этот шлюз до WMS не достаёт — не считаем его в сети, пока не переподключится
            Hosts(wh).TryRemove(login, out _);
            if (_tasks.TryGetValue(job.Id, out var t)) t.Status = "queued";
            Queue(wh).Enqueue(job);
            Signal(wh).Release();
            return true;
        }
        Count(wh, login, status is >= 200 and < 300);
        return job.Result.TrySetResult((status, body));
    }

    // ─── Белый список: только чтение ────────────────────────────────────────
    // GET — любые разделы WMS, кроме входа и смен. POST — только поиск/списки,
    // которые сайт реально вызывает (в WMS они POST, но ничего не меняют).
    // Всё остальное (смена склада, обновление токена, любые изменения) — отказ.
    private static readonly string[] Hosts_ = { "api.samokat.ru", "api-p01.samokat.ru" };
    private static readonly string[] Services = { "/wmsops-wwh/", "/wmsin-wwh/", "/wmsout-wwh/", "/wmsout-pdt/" };
    private static readonly Regex GetDenied = new(@"^/wmsin-wwh/(auth|shifts)(/|$)", RegexOptions.IgnoreCase);
    private static readonly HashSet<string> PostAllowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "/wmsops-wwh/stocks/changes/search",
        "/wmsops-wwh/stocks/v2/details",
        "/wmsops-wwh/products/search",
        "/wmsops-wwh/topology/v2/cells/find",
        "/wmsops-wwh/topology/cells/filters/by-address-search",
        "/wmsout-wwh/picking-selection/tasks",
        "/wmsout-wwh/shipment-order/shipments",
    };

    // Задания целиком: шлюз сам выгружает из WMS и сам сохраняет на сервер
    // (lib/wms/gatewayHost.js, TASKS) — сотруднику возвращается только итог.
    // Через шлюз по одной странице такая выгрузка шла бы втрое дольше.
    private static readonly HashSet<string> TasksAllowed = new(StringComparer.Ordinal)
    {
        "collect:ops", "collect:placement", "collect:remains", "collect:moves", "collect:receiving",
    };

    /// <summary>null — можно; иначе причина отказа.</summary>
    public static string? Validate(string method, string url)
    {
        if (method.Equals("TASK", StringComparison.OrdinalIgnoreCase))
            return TasksAllowed.Contains(url) ? null : "Такое задание через шлюз не выполняется";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https") return "Неверный адрес";
        if (!Hosts_.Contains(uri.Host, StringComparer.OrdinalIgnoreCase)) return "Шлюз ходит только в WMS";
        var path = uri.AbsolutePath;
        if (!Services.Any(s => path.StartsWith(s, StringComparison.OrdinalIgnoreCase))) return "Раздел WMS не разрешён";
        if (path.Contains("..")) return "Неверный адрес";
        return method.ToUpperInvariant() switch
        {
            "GET" => GetDenied.IsMatch(path) ? "Через шлюз нельзя: вход и смены WMS" : null,
            "POST" => PostAllowed.Contains(path.TrimEnd('/')) ? null : "Через шлюз — только просмотр: этот запрос что-то меняет в WMS или не разрешён",
            _ => "Через шлюз — только просмотр",
        };
    }
}
