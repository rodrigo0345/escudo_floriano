using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans.Triggers;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Fire;
using FireTrace.Core.Services.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// Traduz planos e despachos ativos em intervenções que o motor de fogo sabe aplicar. Se uma ação traz `simulationEffects`, usam-se esses;
/// senão deduz-se do tipo de ação e dos meios atribuídos (pessoas, viaturas e água).
/// </summary>
public sealed class PlanInterventions(IDocumentStore<Plan> plans, IDocumentStore<Dispatch> dispatches, IDocumentStore<Vehicle> vehicles, TargetResolver targets, IMapReader map, Rules rules) : IInterventionProvider
{
    public async Task<IReadOnlyList<Intervention>> ForPlanAsync(string planId, CancellationToken ct = default)
    {
        var plan = await plans.GetAsync(planId, ct) ?? throw new NotFoundException($"Plano '{planId}'");
        var result = new List<Intervention>();
        foreach (var action in plan.Actions)
        {
            var ref_ = new PlanActionRef(plan.Id, action.Id);
            var effects = action.SimulationEffects is { Count: > 0 } explicitEffects ? explicitEffects : await DeriveAsync(plan, action, ct);
            result.AddRange(effects.Select(e => e with { PlanActionRef = ref_, Start = action.SimulationEffects is { Count: > 0 } ? e.Start : StartOf(action) }));
        }
        return result;
    }

    static TimeSpec StartOf(PlanAction a) => a.Trigger is AtTimeTrigger t ? t.At : new TimeSpec(OffsetMinutes: 0);

    async Task<IReadOnlyList<Intervention>> DeriveAsync(Plan plan, PlanAction a, CancellationToken ct)
    {
        var start = StartOf(a);
        switch (a)
        {
            case FireAttackAction f:
                if (f.Line is not null && f.ExpectedEffectiveness is { } line) return new Intervention[] { new FireLineIntervention { Start = start, Geometry = f.Line, Effectiveness = line, Method = f.Tactic } };
                return await CrewAsync(plan, a, Responsibility.Firefighting, f.Line ?? (Geometry?)(f.AnchorPoint is { } p ? TargetResolver.PointAt(p.Lat, p.Lon) : null) ?? await targets.GeometryAsync(PlanService.TargetOf(a), plan.LocationId, ct), ct);
            case FuelBreakAction b:
                return new Intervention[] { new FuelRemovalIntervention { Start = start, Geometry = b.Line, WidthM = b.WidthM, Removal = b.Removal, Method = b.Method } };
            case DispatchUnitsAction d:
                return await CrewAsync(plan, a, Responsibility.Firefighting, await targets.GeometryAsync(d.Target, plan.LocationId, ct), ct);
            case StructureProtectionAction s:
                var crew = await CrewAsync(plan, a, Responsibility.StructureProtection, null, ct);
                double effectiveness = (crew.FirstOrDefault() as CrewDeploymentIntervention)?.Effectiveness ?? 0;
                return s.Targets.Select(t => (Intervention)new StructureProtectionIntervention
                {
                    Start = start, PlaceId = t.PlaceId, Geometry = t.Geometry as Polygon, Effectiveness = effectiveness > 0 ? effectiveness : rules.Suppression.BaseEffectiveness,
                }).ToList();
            case RoadClosureAction c:
                return new Intervention[] { new RoadClosureIntervention { Start = start, RoadIds = c.RoadIds, Geometry = c.Geometry, End = c.Until } };
            case EvacuationAction e:
                return new Intervention[] { new EvacuationIntervention { Start = start, Geometry = e.Area, PlaceIds = e.PlaceIds, CompleteBy = e.CompleteBy, Population = e.EstimatedPeople } };
            default:
                return Array.Empty<Intervention>();
        }
    }

    /// <summary>A equipa que o plano põe num sítio: soma das pessoas, viaturas e água das viaturas atribuídas à ação.</summary>
    async Task<IReadOnlyList<Intervention>> CrewAsync(Plan plan, PlanAction a, Responsibility fallback, Geometry? where, CancellationToken ct)
    {
        if (where is null || a.Resources is not { Count: > 0 } resources) return Array.Empty<Intervention>();
        int people = 0, vehicleCount = 0; double water = 0; var responsibility = fallback;
        foreach (var r in resources)
        {
            responsibility = r.Responsibility ?? responsibility;
            if (r.ResourceType == ResourceType.Vehicle && await vehicles.GetAsync(r.ResourceId, ct) is { } v) { vehicleCount++; people += r.Personnel ?? v.CrewCapacity; water += v.WaterCapacityL ?? 0; }
            else if (r.ResourceType == ResourceType.PersonnelPool) people += r.Personnel ?? 0;
        }
        return people == 0 ? Array.Empty<Intervention>()
            : new Intervention[] { new CrewDeploymentIntervention { Start = StartOf(a), Responsibility = responsibility, Personnel = people, Vehicles = vehicleCount, WaterL = water, Geometry = where } };
    }

    /// <summary>Os meios que já estão a trabalhar no terreno (em combate ou a proteger edifícios) travam o fogo onde atuam.</summary>
    public async Task<IReadOnlyList<Intervention>> ForActiveDispatchesAsync(string locationId, CancellationToken ct = default)
    {
        var spec = map.Locations.Get(locationId).Spec;
        var result = new List<Intervention>();
        foreach (var d in (await dispatches.ListAsync(ct)).Where(d => d.Status is DispatchStatus.OnScene or DispatchStatus.Working && d.Responsibility is Responsibility.Firefighting or Responsibility.StructureProtection))
        {
            if (await targets.GeometryAsync(d.Target, locationId, ct) is not { } where || spec.CellAt(where.Centroid.Y, where.Centroid.X) < 0) continue;
            var vehicle = d.ResourceType == ResourceType.Vehicle ? await vehicles.GetAsync(d.ResourceId, ct) : null;
            result.Add(new CrewDeploymentIntervention
            {
                Start = new TimeSpec(OffsetMinutes: 0), Responsibility = d.Responsibility, Personnel = d.Personnel, Vehicles = vehicle is null ? 0 : 1, WaterL = vehicle?.WaterCapacityL ?? 0,
                Geometry = where, PlanActionRef = d.PlanId is { } p && d.ActionId is { } act ? new PlanActionRef(p, act) : null,
            });
        }
        return result;
    }
}
