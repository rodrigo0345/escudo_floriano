using FireTrace.Core.Common;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Models.Meta;
using FireTrace.Engine.Contracts;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Meta;

/// <summary>What the server says about itself: its health, what it supports right now and the rules of the model.</summary>
public sealed class MetaService(Readiness readiness, IFireEngine engine, IMapReader map, LimitsSettings limits, Rules rules)
{
    static readonly string[] Modules = { "map", "resources", "dispatches", "plans", "scenarios", "simulations", "weather" };

    public async Task<HealthReport> HealthAsync(CancellationToken ct = default)
    {
        var health = await engine.HealthAsync(ct);
        return new HealthReport(
            Status: readiness.Database && health is not null ? "ok" : "degraded",
            Version: typeof(MetaService).Assembly.GetName().Version?.ToString(),
            Modules: Modules,
            Engine: new HealthEngine(health is null ? "down" : "ok", health?.Name ?? "ELMFIRE"),
            Database: readiness.Database ? "ok" : "down",
            Locations: map.Locations.All.Select(l => l.Id).ToList());
    }

    public Capabilities Capabilities() => CapabilityCatalog.Build(map.Locations.All.Select(l => l.Id), limits);

    public Rules Rules() => rules;
}
