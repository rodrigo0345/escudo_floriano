using System.Collections.Concurrent;
using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Store;

/// <summary>
/// Guarda em memória o que a API lê muitas vezes (grelhas, estradas, pontos de interesse). Os dados só mudam quando o ingest corre, por isso
/// cada entrada expira ao fim de alguns minutos e passa a refletir o novo ingest sem reiniciar a API.
/// </summary>
public sealed class CachedMapReader : IMapReader
{
    readonly IMapReader _inner;
    readonly TimeSpan _ttl;
    readonly TimeProvider _time;
    readonly ConcurrentDictionary<string, (DateTimeOffset At, Lazy<Task<object?>> Value)> _cache = new();

    public CachedMapReader(IMapReader inner, TimeSpan ttl, TimeProvider time) { _inner = inner; _ttl = ttl; _time = time; }

    public LocationCatalog Locations => _inner.Locations;
    public string DataDir => _inner.DataDir;

    async Task<T> Cached<T>(string kind, string loc, Func<Task<T>> load)
    {
        var key = $"{kind}:{loc}";
        var now = _time.GetUtcNow();
        if (!_cache.TryGetValue(key, out var e) || now - e.At > _ttl)
            _cache[key] = e = (now, new Lazy<Task<object?>>(async () => await load()));
        try { return (T)(await e.Value.Value)!; }
        catch { _cache.TryRemove(key, out _); throw; } // não guardar falhas
    }

    public Task<TerrainGrids> GetTerrainAsync(string loc, CancellationToken ct = default) => Cached("terrain", loc, () => _inner.GetTerrainAsync(loc, ct));
    public Task<RenderHeightmap?> GetRenderHeightmapAsync(string loc, CancellationToken ct = default) => Cached("render", loc, () => _inner.GetRenderHeightmapAsync(loc, ct));
    public Task<RoadNetwork> GetRoadsAsync(string loc, CancellationToken ct = default) => Cached("roads", loc, () => _inner.GetRoadsAsync(loc, ct));
    public Task<IReadOnlyList<Place>> GetPlacesAsync(string loc, CancellationToken ct = default) => Cached("places", loc, () => _inner.GetPlacesAsync(loc, ct));
    public Task<IReadOnlyList<Facility>> GetFacilitiesAsync(string loc, CancellationToken ct = default) => Cached("facilities", loc, () => _inner.GetFacilitiesAsync(loc, ct));
    public Task<IReadOnlyList<WaterPoint>> GetWaterPointsAsync(string loc, CancellationToken ct = default) => Cached("water", loc, () => _inner.GetWaterPointsAsync(loc, ct));
    public Task<IReadOnlyList<Firebreak>> GetFirebreaksAsync(string loc, CancellationToken ct = default) => Cached("firebreaks", loc, () => _inner.GetFirebreaksAsync(loc, ct));
    public Task<IReadOnlyList<Waterway>> GetWaterwaysAsync(string loc, CancellationToken ct = default) => Cached("waterways", loc, () => _inner.GetWaterwaysAsync(loc, ct));
    public Task<IReadOnlyList<ImageryAsset>> GetImageryAsync(string loc, CancellationToken ct = default) => Cached("imagery", loc, () => _inner.GetImageryAsync(loc, ct));
}
