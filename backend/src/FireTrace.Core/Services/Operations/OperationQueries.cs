using System.Collections.Concurrent;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// Os meios de uma simulação: junta o plano que ela aplicou, o resultado do fogo (para o início e a duração) e os recursos que o plano usa, e pede ao <see cref="OperationSimulator"/> o que cada um faz.
/// Uma simulação sem plano (uma base) não tem meios a mover: a lista vem vazia.
/// </summary>
public sealed class OperationQueries(IDocumentStore<Simulation> simulations, IDocumentStore<Plan> plans, IDocumentStore<Vehicle> vehicles, IDocumentStore<PersonnelPool> pools, IDocumentStore<Station> stations,
    TargetResolver targets, IFireRunRepository runs, Rules rules, LimitsSettings limits)
{
    const int CacheLimit = 32;
    readonly ConcurrentDictionary<string, IReadOnlyList<UnitTimeline>> _cache = new();

    /// <summary>
    /// As pistas de todos os meios de uma simulação. Uma simulação acabada não muda (o plano que aplicou pode ser alterado depois, mas a simulação guarda o resultado que viu), e o frontend pede a pista de cada
    /// meio um a um: guarda-se o resultado por simulação, com um limite, para não refazer a conta em cada pedido.
    /// </summary>
    public async Task<IReadOnlyList<UnitTimeline>> TimelinesAsync(string simulationId, CancellationToken ct = default)
    {
        if (_cache.TryGetValue(simulationId, out var cached)) return cached;
        var built = await BuildAsync(simulationId, ct);
        if (_cache.Count >= CacheLimit) _cache.Clear();
        _cache[simulationId] = built;
        return built;
    }

    async Task<IReadOnlyList<UnitTimeline>> BuildAsync(string simulationId, CancellationToken ct)
    {
        var simulation = await simulations.GetAsync(simulationId, ct) ?? throw new NotFoundException($"Simulação '{simulationId}'");
        if (simulation.PlanId is not { } planId || await plans.GetAsync(planId, ct) is not { } plan) return Array.Empty<UnitTimeline>();
        var run = await runs.GetAsync(simulationId, ct) ?? throw new NotFoundException($"O resultado da simulação '{simulationId}'");

        var vehicleOf = new Dictionary<string, Vehicle>();
        var poolOf = new Dictionary<string, PersonnelPool>();
        var stationAt = new Dictionary<string, LatLon>();
        var siteOf = new Dictionary<string, LatLon>();
        foreach (var action in plan.Actions)
        {
            if (await targets.PositionAsync(PlanService.TargetOf(action), plan.LocationId, ct) is { } site) siteOf[action.Id] = site;
            foreach (var r in action.Resources ?? new())
            {
                if (r.ResourceType == ResourceType.Vehicle && !vehicleOf.ContainsKey(r.ResourceId) && await vehicles.GetAsync(r.ResourceId, ct) is { } v) vehicleOf[r.ResourceId] = v;
                if (r.ResourceType == ResourceType.PersonnelPool && !poolOf.ContainsKey(r.ResourceId) && await pools.GetAsync(r.ResourceId, ct) is { } p) poolOf[r.ResourceId] = p;
                foreach (var id in new[] { r.FromStationId, vehicleOf.GetValueOrDefault(r.ResourceId)?.StationId, poolOf.GetValueOrDefault(r.ResourceId)?.StationId })
                    if (id is not null && !stationAt.ContainsKey(id) && await stations.GetAsync(id, ct) is { } station) stationAt[id] = station.Position;
            }
        }
        return OperationSimulator.Simulate(plan, run.Start, run.DurationMinutes, vehicleOf, poolOf, stationAt, siteOf, rules, limits.DefaultActionWindowMinutes);
    }

    /// <summary>O estado de todos os meios ao minuto `tMin`, filtrado por organização e função se pedido.</summary>
    public async Task<UnitStateList> StatesAsync(string simulationId, int tMin, string? organizationId, string? responsibility, CancellationToken ct = default)
    {
        var items = (await TimelinesAsync(simulationId, ct))
            .Where(u => organizationId is null || u.OrganizationId == organizationId)
            .Where(u => responsibility is null || (u.Responsibility is { } r && EnumText.ToSnake(r) == responsibility))
            .Select(u => OperationSimulator.StateAt(u, tMin)).ToList();
        return new UnitStateList(simulationId, tMin, items);
    }

    /// <summary>A posição e o estado de um meio a cada `stepMin` minutos, e todos os seus acontecimentos.</summary>
    public async Task<UnitTrack> TrackAsync(string simulationId, string unitId, int stepMin, CancellationToken ct = default)
    {
        var unit = (await TimelinesAsync(simulationId, ct)).FirstOrDefault(u => u.UnitId == unitId) ?? throw new NotFoundException($"O meio '{unitId}' na simulação '{simulationId}'");
        int step = Math.Max(1, stepMin);
        return new UnitTrack(simulationId, unitId, step, unit.Points.Where(p => p.TMin % step == 0).ToList(), unit.Events);
    }
}
