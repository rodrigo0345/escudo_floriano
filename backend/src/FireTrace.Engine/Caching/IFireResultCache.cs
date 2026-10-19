using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Caching;

/// <summary>Results of finished engine jobs, by job fingerprint.</summary>
public interface IFireResultCache
{
    Task<IReadOnlyDictionary<string, FireResult>?> TryGetAsync(string key, CancellationToken ct = default);
    Task SaveAsync(string key, IReadOnlyDictionary<string, FireResult> results, CancellationToken ct = default);
}
