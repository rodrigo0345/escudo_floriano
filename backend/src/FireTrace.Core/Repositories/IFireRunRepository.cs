using FireTrace.Core.Domain.Fire;

namespace FireTrace.Core.Repositories;

/// <summary>Where the result of a finished simulation is kept (large grids, in files) and read back for the queries.</summary>
public interface IFireRunRepository
{
    Task SaveAsync(FireRun run, CancellationToken ct = default);
    Task<FireRun?> GetAsync(string simulationId, CancellationToken ct = default);
    Task DeleteAsync(string simulationId, CancellationToken ct = default);
}
