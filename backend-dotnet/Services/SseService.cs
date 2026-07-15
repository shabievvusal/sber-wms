using System.Collections.Concurrent;
using System.Text;

namespace BackendDotnet.Services;

// Аналог sseClients/sseNotify из server.js — тот же принцип (набор активных
// HTTP-ответов, широковещание текстового SSE-события). Теперь в процессе
// dotnet, раз запись данных (ship/receive) происходит здесь же.
public class SseService
{
    private readonly ConcurrentDictionary<HttpResponse, byte> _clients = new();

    public void Add(HttpResponse response) => _clients.TryAdd(response, 0);
    public void Remove(HttpResponse response) => _clients.TryRemove(response, out _);

    public async Task NotifyAsync(string eventName)
    {
        var bytes = Encoding.UTF8.GetBytes($"event: {eventName}\ndata: {{}}\n\n");
        foreach (var client in _clients.Keys.ToList())
        {
            try
            {
                await client.Body.WriteAsync(bytes);
                await client.Body.FlushAsync();
            }
            catch
            {
                _clients.TryRemove(client, out _);
            }
        }
    }
}
