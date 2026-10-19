using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Fire;

/// <summary>Os incêndios de exemplo dos ficheiros `locations/*.json` passam a cenários `builtin` (a lista de arranque do frontend).</summary>
public sealed class ScenarioSeeder(IMapReader map, IDocumentStore<Scenario> store, TimeProvider clock)
{
    public async Task SeedAsync(CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        foreach (var location in map.Locations.All)
            foreach (var seed in location.Incidents)
            {
                var scenario = new Scenario
                {
                    Id = $"sc-{seed.Id}", CreatedAt = now, UpdatedAt = now, Builtin = true, Name = seed.Name, Description = seed.Notes, LocationId = location.Id,
                    Purpose = seed.Historical ? ScenarioPurpose.HistoricalReplay : ScenarioPurpose.Planning, Start = seed.Start, DurationMinutes = seed.DurationMinutes,
                    Ignitions = new() { new Ignition(new LatLon(seed.Lat, seed.Lon), Label: seed.Name) }, Weather = new WeatherSpec(), Resources = new ScenarioResources("none"),
                    Engine = new EngineOptions(new EnsembleSpec()), Tags = new() { "builtin" },
                };
                var existing = await store.GetAsync(scenario.Id, ct);
                await store.UpsertAsync(existing is null ? scenario : scenario with { CreatedAt = existing.CreatedAt }, ct);
            }
    }
}
