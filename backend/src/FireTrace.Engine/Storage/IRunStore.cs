namespace FireTrace.Engine.Storage;

/// <summary>Where finished simulations are kept (files: they are large grids), so they are read back instead of recomputed.</summary>
public interface IRunStore
{
    Task SaveAsync(StoredRun run, CancellationToken ct = default);
    Task<StoredRun?> GetAsync(string id, CancellationToken ct = default);
    Task DeleteAsync(string id, CancellationToken ct = default);
}
