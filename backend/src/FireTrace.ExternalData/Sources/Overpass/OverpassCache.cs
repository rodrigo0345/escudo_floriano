using System.Security.Cryptography;
using System.Text;
using FireTrace.ExternalData.Configuration;

namespace FireTrace.ExternalData.Sources.Overpass;

/// <summary>A cache em disco das respostas do Overpass: um ficheiro por pergunta (nomeado pelo hash do texto), em `&lt;dados&gt;/cache/overpass`.</summary>
public sealed class OverpassCache(ExternalDataPaths paths)
{
    public async Task<byte[]?> TryReadAsync(string query, CancellationToken ct = default)
    {
        var file = FileFor(query);
        return File.Exists(file) ? await File.ReadAllBytesAsync(file, ct) : null;
    }

    public async Task WriteAsync(string query, byte[] response, CancellationToken ct = default)
    {
        var file = FileFor(query);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        await File.WriteAllBytesAsync(file, response, ct);
    }

    string FileFor(string query) =>
        Path.Combine(paths.DataDir, "cache", "overpass", Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(query))) + ".json");
}
