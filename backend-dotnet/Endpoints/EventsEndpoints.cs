using BackendDotnet.Services;

namespace BackendDotnet.Endpoints;

// GET /api/rk/events — SSE-подписка (аналог server.js: заголовки text/event-stream,
// держим соединение открытым, регистрируем в SseService, отписываем при закрытии).
public static class EventsEndpoints
{
    public static void MapEventsEndpoints(this WebApplication app)
    {
        app.MapGet("/api/rk/events", async (HttpContext ctx, SseService sse) =>
        {
            var response = ctx.Response;
            response.Headers.ContentType = "text/event-stream";
            response.Headers.CacheControl = "no-cache";
            response.Headers.Connection = "keep-alive";
            await response.WriteAsync("data: connected\n\n");
            await response.Body.FlushAsync();

            sse.Add(response);
            try
            {
                // Держим соединение открытым, пока клиент не отключится — то же
                // самое, что просто не закрывать res в Express.
                var tcs = new TaskCompletionSource();
                await using var registration = ctx.RequestAborted.Register(() => tcs.TrySetResult());
                await tcs.Task;
            }
            finally
            {
                sse.Remove(response);
            }
        }).AddEndpointFilter<VsSessionRequiredFilter>();
    }
}
