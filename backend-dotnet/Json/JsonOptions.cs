using System.Text.Json;

namespace BackendDotnet.Json;

// Общие настройки System.Text.Json — camelCase везде (и для API-ответов, и
// для (де)сериализации JSONB-колонок в AppDbContext), чтобы имена полей
// совпадали с тем, что Node всегда возвращал (routeId, shippedRK и т.д.).
public static class JsonOptions
{
    public static readonly JsonSerializerOptions Default = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
}
