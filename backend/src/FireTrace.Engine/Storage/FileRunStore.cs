using System.Collections.Concurrent;
using System.Text.Json;
using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Storage;

/// <summary>Simulation results as files (`&lt;root&gt;/&lt;id&gt;/`): compact binary grids, a small JSON description and the caller's attachments. Recently read runs are kept in memory.</summary>
public sealed class FileRunStore(string root, RunStoreSettings settings) : IRunStore
{
    sealed record Meta(int Width, int Height, double CellM, int MemberCount, string[] Attachments);

    readonly ConcurrentDictionary<string, Lazy<Task<StoredRun?>>> _cache = new();

    string Dir(string id) => Path.Combine(root, id);

    public async Task SaveAsync(StoredRun run, CancellationToken ct = default)
    {
        var dir = Dir(run.Id);
        var attachmentsDir = Path.Combine(dir, "attachments");
        Directory.CreateDirectory(attachmentsDir);
        var meta = new Meta(run.Grid.Width, run.Grid.Height, run.Grid.CellM, run.Members.Length, run.Attachments.Keys.ToArray());
        await File.WriteAllTextAsync(Path.Combine(dir, "run.json"), JsonSerializer.Serialize(meta), ct);
        await File.WriteAllBytesAsync(Path.Combine(dir, "ignition.i16"), BinaryArrays.PackMinutes(run.Ignition), ct);
        await File.WriteAllBytesAsync(Path.Combine(dir, "members.i16"), BinaryArrays.PackMinutes(run.Members.SelectMany(m => m).ToArray()), ct);
        await File.WriteAllBytesAsync(Path.Combine(dir, "intensity.u16"), BinaryArrays.ToBytes(run.IntensityKwm), ct);
        await File.WriteAllBytesAsync(Path.Combine(dir, "flags.u8"), run.Flags, ct);
        foreach (var (name, bytes) in run.Attachments) await File.WriteAllBytesAsync(Path.Combine(attachmentsDir, name), bytes, ct);
        _cache.TryRemove(run.Id, out _);
    }

    public Task<StoredRun?> GetAsync(string id, CancellationToken ct = default)
    {
        if (_cache.Count > settings.CacheCapacity) _cache.Clear(); // só se guardam as corridas mais usadas
        return _cache.GetOrAdd(id, i => new Lazy<Task<StoredRun?>>(() => LoadAsync(i))).Value;
    }

    public Task DeleteAsync(string id, CancellationToken ct = default)
    {
        _cache.TryRemove(id, out _);
        if (Directory.Exists(Dir(id))) Directory.Delete(Dir(id), true);
        return Task.CompletedTask;
    }

    async Task<StoredRun?> LoadAsync(string id)
    {
        var dir = Dir(id);
        if (!File.Exists(Path.Combine(dir, "run.json"))) return null;
        var meta = JsonSerializer.Deserialize<Meta>(await File.ReadAllTextAsync(Path.Combine(dir, "run.json")))!;
        var ignition = BinaryArrays.UnpackMinutes(await File.ReadAllBytesAsync(Path.Combine(dir, "ignition.i16")));
        var all = BinaryArrays.UnpackMinutes(await File.ReadAllBytesAsync(Path.Combine(dir, "members.i16")));
        var members = Enumerable.Range(0, meta.MemberCount).Select(i => all.AsSpan(i * ignition.Length, ignition.Length).ToArray()).ToArray();
        var attachments = new Dictionary<string, byte[]>();
        foreach (var name in meta.Attachments) attachments[name] = await File.ReadAllBytesAsync(Path.Combine(dir, "attachments", name));
        return new StoredRun(id, new EngineGrid(meta.Width, meta.Height, meta.CellM), ignition, members,
            BinaryArrays.FromBytes<ushort>(await File.ReadAllBytesAsync(Path.Combine(dir, "intensity.u16"))), await File.ReadAllBytesAsync(Path.Combine(dir, "flags.u8")), attachments);
    }
}
