namespace FireTrace.Core.Repositories;

public sealed class FileApiSpecRepository(string path) : IApiSpecRepository
{
    public async Task<byte[]?> ReadAsync(CancellationToken ct = default) => File.Exists(path) ? await File.ReadAllBytesAsync(path, ct) : null;
}
