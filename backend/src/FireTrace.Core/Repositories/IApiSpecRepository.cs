namespace FireTrace.Core.Repositories;

/// <summary>Where the published OpenAPI contract is read from.</summary>
public interface IApiSpecRepository
{
    /// <summary>The contract's bytes, or null when the file is missing.</summary>
    Task<byte[]?> ReadAsync(CancellationToken ct = default);
}
