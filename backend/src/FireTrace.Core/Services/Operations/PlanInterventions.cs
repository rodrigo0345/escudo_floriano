using FireTrace.Core.Configuration;
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
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// Traduz planos e despachos ativos em intervenções que o motor de fogo sabe aplicar. Se uma ação traz `simulationEffects`, usam-se esses;
/// senão deduz-se do tipo de ação e dos meios atribuídos (pessoas, viaturas e água).
/// </summary>
public sealed class PlanInterventions(IDocumentStore<Plan> plans, IDocumentStore<Dispatch> dispatches, IDocumentStore<Vehicle> vehicles, TargetResolver targets, IMapReader map, Rules rules, LimitsSettings limits, InterventionSettings interventions, ArrivalEstimator arrival) : IInterventionProvider
{
    public async Task<IReadOnlyList<Intervention>> ForPlanAsync(string planId, CancellationToken ct = default)
    {
        var plan = await plans.GetAsync(planId, ct) ?? throw new NotFoundException($"Plano '{planId}'");
        var result = new List<Intervention>();
        foreach (var action in plan.Actions)
        {
            var ref_ = new PlanActionRef(plan.Id, action.Id);
            var effects = action.SimulationEffects is { Count: > 0 } explicitEffects ? explicitEffects : await DeriveAsync(plan, action, ct);
            result.AddRange(effects.Select(e => e with { PlanActionRef = ref_ }));
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
                if (f.Line is not null && f.ExpectedEffectiveness is { } line) return new Intervention[] { await LineAsync(plan, a, f, line, ct) };
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

    /// <summary>
    /// Uma linha de contenção feita por equipas: só começa a travar o fogo depois de as equipas chegarem (`etaMinutes`) e de a abrirem
    /// (comprimento / (pessoas × ritmo de abertura)). Sem equipas atribuídas, a linha já existe à hora do gatilho (um aceiro, por exemplo).
    /// </summary>
    async Task<Intervention> LineAsync(Plan plan, PlanAction a, FireAttackAction f, double effectiveness, CancellationToken ct)
    {
        int people = 0; double eta = 0;
        foreach (var r in a.Resources ?? new())
        {
            if (r.ResourceType == ResourceType.Vehicle && await vehicles.GetAsync(r.ResourceId, ct) is { } v)
            {
                if (await ArrivalOf(plan, a, v, r, f.Line!, ct) is not { } minutes) continue; // sem estrada até à linha a equipa não chega: não a abre
                eta = Math.Max(eta, minutes);
                people += r.Personnel ?? v.CrewCapacity;
            }
            else if (r.ResourceType == ResourceType.PersonnelPool) { eta = Math.Max(eta, r.EtaMinutes ?? 0); people += r.Personnel ?? 0; }
        }
        var c = f.Line!.Coordinates;
        double lengthM = Enumerable.Range(1, c.Length - 1).Sum(i => RoadGeometry.DistanceM(c[i - 1].Y, c[i - 1].X, c[i].Y, c[i].X));
        int construction = people == 0 ? 0 : (int)Math.Ceiling(lengthM / (people * interventions.FireLineRateMPerHourPerPerson / 60));
        return new FireLineIntervention
        {
            Start = new TimeSpec(OffsetMinutes: (int)Math.Round(StartMinutes(plan, a) + (people == 0 ? 0 : eta))), ConstructionMinutes = construction, Geometry = f.Line, Effectiveness = effectiveness, Method = f.Tactic,
        };
    }

    /// <summary>
    /// A equipa que o plano põe num sítio: pessoas, viaturas e água das viaturas atribuídas à ação, a chegar `etaMinutes` depois do gatilho e a combater por janelas
    /// (com água, a reabastecer, cansada: ver <see cref="CrewWorkSchedule"/>). Cada janela é uma intervenção com a sua hora de início e duração.
    /// </summary>
    async Task<IReadOnlyList<Intervention>> CrewAsync(Plan plan, PlanAction a, Responsibility fallback, Geometry? where, CancellationToken ct)
    {
        if (where is null || a.Resources is not { Count: > 0 } resources) return Array.Empty<Intervention>();
        int people = 0, vehicleCount = 0; double water = 0, pump = 0, eta = 0; var responsibility = fallback;
        foreach (var r in resources)
        {
            responsibility = r.Responsibility ?? responsibility;
            if (r.ResourceType == ResourceType.Vehicle && await vehicles.GetAsync(r.ResourceId, ct) is { } v)
            {
                if (await ArrivalOf(plan, a, v, r, where, ct) is not { } minutes) continue; // sem estrada até lá a equipa não chega: não trava o fogo
                eta = Math.Max(eta, minutes);
                vehicleCount++; people += r.Personnel ?? v.CrewCapacity; water += v.WaterCapacityL ?? 0; pump += v.PumpFlowLpm ?? 0;
            }
            else if (r.ResourceType == ResourceType.PersonnelPool) { eta = Math.Max(eta, r.EtaMinutes ?? 0); people += r.Personnel ?? 0; }
        }
        if (people == 0) return Array.Empty<Intervention>();

        double arrival = StartMinutes(plan, a) + eta, until = arrival + (a.ExpectedDurationMinutes ?? limits.DefaultActionWindowMinutes);
        return CrewWorkSchedule.Plan(arrival, until, water, pump, rules).Select(s => (Intervention)new CrewDeploymentIntervention
        {
            Start = new TimeSpec(OffsetMinutes: (int)Math.Round(s.FromMinute)), DurationMinutes = Math.Max(1, (int)Math.Round(s.Minutes)), Responsibility = responsibility, Personnel = people, Vehicles = vehicleCount, WaterL = water, Geometry = where,
            Effectiveness = InterventionApplier.CrewEffectiveness(people, water, rules.Suppression) * s.Fatigue,
        }).ToList();
    }

    /// <summary>Minuto (desde o início do cenário) em que o gatilho da ação a manda começar; sem gatilho de hora, ao ativar (0).</summary>
    static double StartMinutes(Plan plan, PlanAction a) => PlanTiming.StartMinutes(plan, a);

    /// <summary>
    /// Quanto demora a viatura a chegar onde a ação atua, calculado pelo servidor (estrada, cortes, tipo de viatura, a pé no fim): o `etaMinutes` que o plano traga não conta.
    /// Nada se não houver estrada até lá. Só sem posição de partida se usa o do plano.
    /// </summary>
    async Task<double?> ArrivalOf(Plan plan, PlanAction a, Vehicle v, ResourceAssignment r, Geometry where, CancellationToken ct)
    {
        if (await arrival.OriginAsync(v, r.FromStationId, ct) is not { } from) return r.EtaMinutes;
        return (await arrival.EstimateAsync(v, from, new LatLon(where.Centroid.Y, where.Centroid.X), plan.LocationId, PlanTiming.StartAt(plan, a), ct)).Minutes;
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
