using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Caching;

/// <summary>Runs a job only if its result is not already stored: the same job (same fingerprint) is answered from disk instead of being simulated again.</summary>
public sealed class CachedFireEngine(IFireEngine inner, IFireResultCache cache, string scope) : IFireEngine
{
    public Task<EngineHealth?> HealthAsync(CancellationToken ct = default) => inner.HealthAsync(ct);

    public async Task<IReadOnlyDictionary<string, FireResult>> RunAsync(FireJob job, CancellationToken ct = default)
    {
        var key = FireJobFingerprint.Of(job, scope);
        if (await cache.TryGetAsync(key, ct) is { } cached)
        {
            job.Progress?.Invoke(job.Members.Count, job.Members.Count);
            return cached;
        }
        var results = await inner.RunAsync(job, ct);
        await cache.SaveAsync(key, results, ct);
        return results;
    }
}
