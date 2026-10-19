using System.Text.Json;
using System.Text.RegularExpressions;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans.Triggers;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Fire;
using FireTrace.Core.Services.Map;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Operations;

/// <summary>Verificações automáticas de um plano: referências a meios e organizações, dependências sem ciclos, conflitos de meios e segurança.</summary>
public sealed class PlanValidator(IMapReader map, IDocumentStore<Organization> organizations, IDocumentStore<Vehicle> vehicles, IDocumentStore<PersonnelPool> pools,
    IDocumentStore<Equipment> equipment, IDocumentStore<Scenario> scenarios, IDocumentStore<Simulation> simulations, IFireRunRepository runs, CrewSafety crewSafety, TimeProvider clock, ResponsibilityRules rules, LimitsSettings limits, InterventionSettings interventions, SmokeService smoke, TargetResolver targets)
{
    public async Task<PlanValidation> ValidateAsync(Plan plan, CancellationToken ct = default)
    {
        var issues = new List<ValidationIssue>();
        void Add(string severity, string code, string message, string pointer, string? actionId = null, string? resourceId = null) => issues.Add(new(severity, code, message, pointer, actionId, resourceId));

        if (map.Locations.Find(plan.LocationId) is null) Add("error", "unknown_location", $"Local '{plan.LocationId}' desconhecido.", "/locationId");
        if (plan.Variant is { } variant && !Regex.IsMatch(variant, "^[A-Z]$")) Add("error", "invalid_variant", "`variant` é uma letra maiúscula (A, B…).", "/variant");
        if (plan.Actions.Count > limits.MaxActionsPerPlan) Add("error", "too_many_actions", $"Um plano tem no máximo {limits.MaxActionsPerPlan} ações.", "/actions");
        if (plan.Basis?.ScenarioId is { } sc)
        {
            if (await scenarios.GetAsync(sc, ct) is not { } scenario) Add("error", "unknown_scenario", $"Cenário '{sc}' desconhecido.", "/basis/scenarioId");
            else if (scenario.LocationId != plan.LocationId) Add("error", "location_mismatch", $"O cenário '{sc}' é do local '{scenario.LocationId}', não de '{plan.LocationId}'.", "/basis/scenarioId");
        }
        if (plan.Basis?.SimulationId is { } sim && await simulations.GetAsync(sim, ct) is null) Add("error", "unknown_simulation", $"Simulação '{sim}' desconhecida.", "/basis/simulationId");

        var knownOrgs = (await organizations.ListAsync(ct)).Select(o => o.Id).ToHashSet();
        var ids = new HashSet<string>();
        foreach (var (a, i) in plan.Actions.Select((a, i) => (a, i)))
            if (string.IsNullOrWhiteSpace(a.Id) || !ids.Add(a.Id)) Add("error", "duplicate_action_id", $"O id de ação '{a.Id}' está vazio ou repetido.", $"/actions/{i}/id", a.Id);

        var network = plan.Actions.OfType<RoadClosureAction>().Any() && map.Locations.Find(plan.LocationId) is not null ? await map.GetRoadsAsync(plan.LocationId, ct) : null;
        var knownRoads = network?.Edges.Select(e => e.Id).ToHashSet();

        for (int i = 0; i < plan.Actions.Count; i++)
        {
            var a = plan.Actions[i]; string at = $"/actions/{i}";
            if (!knownOrgs.Contains(a.OrganizationId)) Add("error", "unknown_organization", $"Organização '{a.OrganizationId}' desconhecida.", $"{at}/organizationId", a.Id);
            foreach (var org in (a.SupportingOrganizationIds ?? new()).Where(o => !knownOrgs.Contains(o))) Add("error", "unknown_organization", $"Organização '{org}' desconhecida.", $"{at}/supportingOrganizationIds", a.Id);
            foreach (var dep in (a.DependsOn ?? new()).Where(d => d == a.Id || !ids.Contains(d))) Add("error", "unknown_dependency", $"A ação depende de '{dep}', que não existe neste plano.", $"{at}/dependsOn", a.Id);

            foreach (var (r, j) in (a.Resources ?? new()).Select((r, j) => (r, j))) await CheckResource(r, $"{at}/resources/{j}", a, Add, ct);

            switch (a)
            {
                case RoadClosureAction c when knownRoads is not null:
                    foreach (var road in c.RoadIds.Where(r => MapIds.RoadNumber(r) is not { } n || !knownRoads.Contains(n))) Add("error", "unknown_road", $"Troço '{road}' desconhecido.", $"{at}/roadIds", a.Id);
                    break;
                case FireAttackAction f when f.EscapeRoutes is not { Count: > 0 } || f.SafetyZones is not { Count: > 0 }:
                    Add("warning", "missing_safety", "Ataque ao fogo sem vias de fuga ou zonas de segurança indicadas.", at, a.Id);
                    break;
                case FuelBreakAction b:
                    if (b.EscapeRoutes is not { Count: > 0 } || b.SafetyZones is not { Count: > 0 }) Add("warning", "missing_safety", "Corte de combustível sem vias de fuga ou zonas de segurança indicadas.", at, a.Id);
                    if (map.Locations.Find(plan.LocationId) is { } loc && b.Line.Coordinates.Any(c => loc.Spec.CellAt(c.Y, c.X) < 0)) Add("error", "outside_location", "A faixa de corte sai da área do local.", $"{at}/line", a.Id);
                    await CheckFuelBreakCrew(b, at, Add, ct);
                    break;
            }
        }

        if (plan.Basis?.SimulationId is { } basisSimulation)
        {
            await CheckSmokeAsync(plan, basisSimulation, Add, ct);
            await CheckCrewExposureAsync(plan, basisSimulation, Add, ct);
        }

        var reach = Dependencies(plan);
        if (reach.Any(kv => kv.Value.Contains(kv.Key))) Add("error", "dependency_cycle", "As dependências entre ações têm um ciclo.", "/actions");
        foreach (var group in plan.Actions.SelectMany(a => (a.Resources ?? new()).Select(r => (Key: (r.ResourceType, r.ResourceId), Action: a))).GroupBy(x => x.Key))
        {
            var actions = group.Select(x => x.Action).Distinct().ToList();
            for (int x = 0; x < actions.Count; x++)
                for (int y = x + 1; y < actions.Count; y++)
                    if (!reach[actions[x].Id].Contains(actions[y].Id) && !reach[actions[y].Id].Contains(actions[x].Id))
                        Add("warning", "resource_conflict", $"O meio {group.Key.ResourceId} está em duas ações que podem decorrer ao mesmo tempo ({actions[x].Id}, {actions[y].Id}).", "/actions", resourceId: group.Key.ResourceId);
        }
        return new PlanValidation(issues.All(i => i.Severity != "error"), clock.GetUtcNow(), issues);
    }

    /// <summary>
    /// Com uma simulação como base, vê se o fumo tira a visibilidade onde cada ação trabalha enquanto decorre (a partir do gatilho `at_time`, senão desde o início):
    /// avisa de quando começa e de quando volta a ser seguro, para o plano não mandar ninguém para onde não se vê.
    /// </summary>
    async Task CheckSmokeAsync(Plan plan, string simulationId, Action<string, string, string, string, string?, string?> add, CancellationToken ct)
    {
        if (await simulations.GetAsync(simulationId, ct) is not { Status: SimulationStatus.Succeeded } sim) return;
        for (int i = 0; i < plan.Actions.Count; i++)
        {
            var a = plan.Actions[i];
            var spots = (await WorkPlacesAsync(a, plan.LocationId, ct)).ToList();
            if (spots.Count == 0) continue;
            int start = a.Trigger is AtTimeTrigger t ? (int)Math.Max(0, t.At.MinutesFrom(sim.ScenarioSnapshot.Start)) : 0;
            var result = await smoke.QueryAsync(simulationId, new SmokeQuery(spots.Select(p => new SmokePointRef(null, p)).ToList(), start, start + (a.ExpectedDurationMinutes ?? limits.DefaultActionWindowMinutes), limits.ActionSmokeStepMinutes), ct);
            if (result.Items.Where(s => s.UnsafeFromMin is not null).MinBy(s => s.MinVisibilityM) is not { } worst) continue;
            string again = worst.SafeAgainAtMin is { } safe ? $"volta a ser seguro aos T+{safe} min" : "não volta a ser seguro no período";
            add("warning", "smoke_unsafe", $"Fumo denso onde a ação trabalha: visibilidade mínima {Math.Round(worst.MinVisibilityM)} m (limite {Math.Round(result.MinGroundVisibilityM)} m) a partir dos T+{worst.UnsafeFromMin} min; {again}.", $"/actions/{i}", a.Id, null);
        }
    }

    /// <summary>Com uma simulação como base, avisa das equipas que o fogo previsto apanha (a caminho ou no local): as baixas saem das regras de equipas, o plano é que as evita.</summary>
    async Task CheckCrewExposureAsync(Plan plan, string simulationId, Action<string, string, string, string, string?, string?> add, CancellationToken ct)
    {
        if (await runs.GetAsync(simulationId, ct) is not { } run) return;
        foreach (var e in await crewSafety.EvaluateAsync(plan, run, ct))
        {
            int i = plan.Actions.ToList().FindIndex(a => a.Id == e.ActionId);
            add("warning", "crew_in_fire", $"A equipa da viatura {e.VehicleId} fica apanhada pelo fogo previsto a partir dos T+{e.FirstMinute} min ({e.MinutesInFire} min no fogo, {e.Casualties} de {e.Personnel} baixas).", $"/actions/{i}", e.ActionId, e.VehicleId);
        }
    }

    /// <summary>Os sítios onde uma ação põe gente a trabalhar (para ver o fumo): o destino, a faixa, a posição ou o posto de comando.</summary>
    async Task<IEnumerable<LatLon>> WorkPlacesAsync(PlanAction a, string locationId, CancellationToken ct)
    {
        async Task<LatLon?> Centre(Target t) => await targets.GeometryAsync(t, locationId, ct) is { } g ? new LatLon(g.Centroid.Y, g.Centroid.X) : null;
        static IEnumerable<LatLon> Along(NetTopologySuite.Geometries.LineString line) => new[] { line.GetCoordinateN(0), line.Centroid.Coordinate, line.GetCoordinateN(line.NumPoints - 1) }.Select(c => new LatLon(c.Y, c.X));
        switch (a)
        {
            case FireAttackAction { Line: { } line }: return Along(line);
            case FireAttackAction { AnchorPoint: { } at }: return new[] { at };
            case FuelBreakAction b: return Along(b.Line);
            case DispatchUnitsAction d: return (await Centre(d.Target)) is { } p ? new[] { p } : Array.Empty<LatLon>();
            case StageResourcesAction s: return (await Centre(s.StagingArea)) is { } q ? new[] { q } : Array.Empty<LatLon>();
            case EstablishCommandPostAction c: return (await Centre(c.Location)) is { } r ? new[] { r } : Array.Empty<LatLon>();
            case StructureProtectionAction sp: return (await Task.WhenAll(sp.Targets.Select(Centre))).OfType<LatLon>();
            default: return Array.Empty<LatLon>();
        }
    }

    /// <summary>Uma faixa sem pessoas atribuídas não se corta; com poucas pessoas pode demorar mais do que a ação prevê.</summary>
    async Task CheckFuelBreakCrew(FuelBreakAction b, string at, Action<string, string, string, string, string?, string?> add, CancellationToken ct)
    {
        int people = 0;
        foreach (var r in b.Resources ?? new())
            people += r.Personnel ?? (r.ResourceType == ResourceType.Vehicle && await vehicles.GetAsync(r.ResourceId, ct) is { } v ? v.CrewCapacity : 0);
        if (people == 0) { add("warning", "fuel_break_no_crew", "Corte de combustível sem pessoas atribuídas: ninguém o executa.", $"{at}/resources", b.Id, null); return; }
        double lengthM = Enumerable.Range(1, b.Line.Coordinates.Length - 1).Sum(i => RoadGeometry.DistanceM(b.Line.Coordinates[i - 1].Y, b.Line.Coordinates[i - 1].X, b.Line.Coordinates[i].Y, b.Line.Coordinates[i].X));
        double minutes = lengthM / (people * interventions.FuelRemoval.CrewRateMPerHourPerPerson) * 60;
        if (b.ExpectedDurationMinutes is { } planned && minutes > planned)
            add("warning", "fuel_break_slow", $"{Math.Round(lengthM)} m com {people} pessoas levam cerca de {Math.Round(minutes)} min, mais que os {planned} min previstos.", at, b.Id, null);
    }

    /// <summary>Para cada ação, todas as ações de que depende (direta ou indiretamente).</summary>
    static Dictionary<string, HashSet<string>> Dependencies(Plan plan)
    {
        var direct = plan.Actions.GroupBy(a => a.Id).ToDictionary(g => g.Key, g => g.First().DependsOn ?? new());
        var result = new Dictionary<string, HashSet<string>>();
        foreach (var id in direct.Keys)
        {
            var seen = new HashSet<string>(); var stack = new Stack<string>(direct[id]);
            while (stack.Count > 0) { var d = stack.Pop(); if (seen.Add(d) && direct.TryGetValue(d, out var next)) foreach (var n in next) stack.Push(n); }
            result[id] = seen;
        }
        return result;
    }

    async Task CheckResource(ResourceAssignment r, string at, PlanAction action, Action<string, string, string, string, string?, string?> add, CancellationToken ct)
    {
        switch (r.ResourceType)
        {
            case ResourceType.Vehicle when await vehicles.GetAsync(r.ResourceId, ct) is { } v:
                if (r.Personnel is { } n && (n < (v.MinimumCrew ?? 1) || n > v.CrewCapacity)) add("warning", "crew_range", $"A viatura {v.Callsign} leva entre {v.MinimumCrew ?? 1} e {v.CrewCapacity} pessoas.", $"{at}/personnel", action.Id, v.Id);
                if (r.Responsibility is { } resp && !rules.Supports(resp, v.Capabilities)) add("warning", "responsibility_not_supported", $"A viatura {v.Callsign} não tem capacidades para '{EnumText.ToSnake(resp)}'.", $"{at}/responsibility", action.Id, v.Id);
                break;
            case ResourceType.PersonnelPool when await pools.GetAsync(r.ResourceId, ct) is { } p:
                if (r.Personnel > p.Total) add("warning", "not_enough_personnel", $"O grupo só tem {p.Total} pessoas.", $"{at}/personnel", action.Id, p.Id);
                break;
            case ResourceType.Equipment when await equipment.GetAsync(r.ResourceId, ct) is { } e:
                if (r.Quantity > e.Quantity) add("warning", "not_enough_equipment", $"Só existem {e.Quantity} unidades.", $"{at}/quantity", action.Id, e.Id);
                break;
            default:
                add("error", "unknown_resource", $"Meio '{r.ResourceId}' ({EnumText.ToSnake(r.ResourceType)}) desconhecido.", $"{at}/resourceId", action.Id, r.ResourceId);
                break;
        }
    }
}
