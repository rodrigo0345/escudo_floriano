namespace FireTrace.Engine.Contracts;

/// <summary>O motor de propagação do fogo (hoje o ELMFIRE, num contentor). A aplicação só conhece esta porta.</summary>
public interface IFireEngine
{
    Task<EngineHealth?> HealthAsync(CancellationToken ct = default);
    Task<IReadOnlyDictionary<string, FireResult>> RunAsync(FireJob job, CancellationToken ct = default);
}
