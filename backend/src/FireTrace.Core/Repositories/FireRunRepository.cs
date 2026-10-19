using System.Text.Json;
using FireTrace.Core.Common;
using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Serialization;
using FireTrace.Engine.Storage;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Repositories;

/// <summary>
/// Keeps a <see cref="FireRun"/> in the engine's run store: the engine saves the grids it produced, and what only the API knows (location, start, weather
/// samples, building protection) travels with them as attachments.
/// </summary>
public sealed class FireRunRepository(IRunStore store, IMapReader map) : IFireRunRepository
{
    const string MetaFile = "run.json", WeatherFile = "weather.json", BuildingsFile = "buildings.f32";

    sealed record Meta(string LocationId, DateTimeOffset Start, int DurationMinutes);

    public Task SaveAsync(FireRun run, CancellationToken ct = default)
    {
        var attachments = new Dictionary<string, byte[]>
        {
            [MetaFile] = JsonSerializer.SerializeToUtf8Bytes(new Meta(run.LocationId, run.Start, run.DurationMinutes), ApiJson.Options),
            [WeatherFile] = JsonSerializer.SerializeToUtf8Bytes(run.Weather, ApiJson.Options),
        };
        if (run.BuildingFactor is { } factor) attachments[BuildingsFile] = BinaryArrays.ToBytes(factor);
        return store.SaveAsync(new StoredRun(run.SimulationId, run.Spec.ToEngineGrid(), run.Ignition, run.Members, run.IntensityKwm, run.Flags, attachments), ct);
    }

    public async Task<FireRun?> GetAsync(string simulationId, CancellationToken ct = default)
    {
        if (await store.GetAsync(simulationId, ct) is not { } stored) return null;
        var meta = JsonSerializer.Deserialize<Meta>(stored.Attachments[MetaFile], ApiJson.Options)!;
        return new FireRun
        {
            SimulationId = simulationId, LocationId = meta.LocationId, Spec = map.Locations.Get(meta.LocationId).Spec, Start = meta.Start, DurationMinutes = meta.DurationMinutes,
            Ignition = stored.Ignition, Members = stored.Members, IntensityKwm = stored.IntensityKwm, Flags = stored.Flags,
            BuildingFactor = stored.Attachments.TryGetValue(BuildingsFile, out var buildings) ? BinaryArrays.FromBytes<float>(buildings) : null,
            Weather = JsonSerializer.Deserialize<List<WeatherSample>>(stored.Attachments[WeatherFile], ApiJson.Options)!,
        };
    }

    public Task DeleteAsync(string simulationId, CancellationToken ct = default) => store.DeleteAsync(simulationId, ct);
}
