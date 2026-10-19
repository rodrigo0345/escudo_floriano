using System.Text.Json;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Storage;

namespace FireTrace.Engine.Caching;

/// <summary>Engine results on disk (`&lt;root&gt;/&lt;key&gt;/`): one set of grids per ensemble member. An entry becomes visible only when complete (written aside, then renamed).</summary>
public sealed class FileFireResultCache(string root) : IFireResultCache
{
    const string Members = "members.json";

    public async Task<IReadOnlyDictionary<string, FireResult>?> TryGetAsync(string key, CancellationToken ct = default)
    {
        var dir = Path.Combine(root, key);
        if (!File.Exists(Path.Combine(dir, Members))) return null;
        var names = JsonSerializer.Deserialize<string[]>(await File.ReadAllTextAsync(Path.Combine(dir, Members), ct))!;
        var results = new Dictionary<string, FireResult>();
        foreach (var name in names)
            results[name] = new FireResult
            {
                Ignition = BinaryArrays.UnpackMinutes(await File.ReadAllBytesAsync(Path.Combine(dir, $"{name}.i16"), ct)),
                IntensityKwm = BinaryArrays.FromBytes<ushort>(await File.ReadAllBytesAsync(Path.Combine(dir, $"{name}.u16"), ct)),
                Flags = await File.ReadAllBytesAsync(Path.Combine(dir, $"{name}.u8"), ct),
            };
        return results;
    }

    public async Task SaveAsync(string key, IReadOnlyDictionary<string, FireResult> results, CancellationToken ct = default)
    {
        var dir = Path.Combine(root, key);
        if (Directory.Exists(dir)) return;
        var pending = dir + ".pending-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(pending);
        foreach (var (name, result) in results)
        {
            await File.WriteAllBytesAsync(Path.Combine(pending, $"{name}.i16"), BinaryArrays.PackMinutes(result.Ignition), ct);
            await File.WriteAllBytesAsync(Path.Combine(pending, $"{name}.u16"), BinaryArrays.ToBytes(result.IntensityKwm), ct);
            await File.WriteAllBytesAsync(Path.Combine(pending, $"{name}.u8"), result.Flags, ct);
        }
        await File.WriteAllTextAsync(Path.Combine(pending, Members), JsonSerializer.Serialize(results.Keys.ToArray()), ct);
        try { Directory.Move(pending, dir); }
        catch (IOException) { Directory.Delete(pending, true); } // another run saved the same job first: keep theirs
    }
}
