using System.Globalization;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// Simula a execução de um plano minuto a minuto: cada viatura sai do seu posto, segue a rota por estrada, chega, trabalha
/// (com água, reabastecimentos e descansos) e regressa. É determinístico e não altera o fogo: o resultado é a base de
/// `GET /simulations/{id}/units` e `/units/{unitId}/track`.
/// </summary>
public sealed class OperationSimulator(
    IDocumentStore<Simulation> simulations,
    IDocumentStore<Plan> plans,
    IDocumentStore<Vehicle> vehicles,
    IDocumentStore<PersonnelPool> pools,
    IDocumentStore<Station> stations,
    IDocumentStore<Dispatch> dispatches,
    IFireRunRepository runs,
    ArrivalEstimator arrival,
    TargetResolver targets,
    FireTraceSettings settings)
{
    sealed record Demand(
        string UnitId,
        ResourceType ResourceType,
        string? Callsign,
        string OrganizationId,
        Responsibility? Responsibility,
        int Personnel,
        Target Target,
        LatLon Site,
        Vehicle? Vehicle,
        PersonnelPool? Pool,
        LineString? Route,
        LatLon? Origin,
        double Start,
        double Eta,
        double WorkStart,
        double WorkEnd,
        double ReturnEnd,
        double WaterCapacityL,
        double WaterPerMinuteL,
        bool Aerial);

    sealed record WorkState(DispatchStatus Status, double WaterL, int WorkedMinutes, double FatiguePct, int? EmptyAtMinute);

    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);

    public async Task<UnitStateList> UnitsAsync(string simulationId, int tMin, string? organizationId, string? responsibility, CancellationToken ct)
    {
        var (run, plan) = await ContextAsync(simulationId, ct);
        var demands = plan is null ? new List<Demand>() : await DemandsAsync(plan, run, ct);
        var wanted = responsibility?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var items = demands
            .Where(d => organizationId is null || d.OrganizationId == organizationId)
            .Where(d => wanted is null || wanted.Length == 0 || (d.Responsibility is { } r && wanted.Contains(EnumText.ToSnake(r))))
            .OrderBy(d => d.UnitId, StringComparer.Ordinal)
            .Select(d => StateAt(d, tMin, run))
            .ToList();
        return new UnitStateList(simulationId, tMin, items);
    }

    public async Task<UnitTrack> TrackAsync(string simulationId, string unitId, int stepMin, CancellationToken ct)
    {
        var (run, plan) = await ContextAsync(simulationId, ct);
        var demands = plan is null ? new List<Demand>() : await DemandsAsync(plan, run, ct);
        var demand = demands.FirstOrDefault(d => d.UnitId == unitId) ?? throw new NotFoundException($"Meio '{unitId}' na simulação '{simulationId}'");
        var step = Math.Clamp(stepMin, 1, 60);
        var points = new List<UnitTrackPoint>();
        for (int t = 0; t <= run.DurationMinutes; t += step) points.Add(PointAt(demand, t, run));
        if (points.Count == 0 || points[^1].TMin != run.DurationMinutes) points.Add(PointAt(demand, run.DurationMinutes, run));
        return new UnitTrack(simulationId, unitId, step, points, Events(demand, run));
    }

    /// <summary>
    /// The pure part of the simulator, for callers that have already loaded the plan's resources: what each unit does,
    /// minute by minute, without touching the database. Kept as the tested entry point for the operation planning
    /// services; the injected <see cref="UnitsAsync"/> and <see cref="TrackAsync"/> below add the plan/dispatch
    /// persistence and the HTTP filters around them.
    /// </summary>
    public static IReadOnlyList<UnitTimeline> Simulate(Plan plan, DateTimeOffset scenarioStart, int durationMinutes,
        IReadOnlyDictionary<string, Vehicle> vehicles, IReadOnlyDictionary<string, PersonnelPool> pools,
        IReadOnlyDictionary<string, LatLon> stations, IReadOnlyDictionary<string, LatLon> sites, Rules rules, int defaultWindowMinutes)
    {
        var timelines = new List<UnitTimeline>();
        var seen = new HashSet<string>();
        foreach (var action in plan.Actions)
        {
            if (!sites.TryGetValue(action.Id, out var site)) continue;
            foreach (var r in action.Resources ?? new())
            {
                Vehicle? v = r.ResourceType == ResourceType.Vehicle && vehicles.TryGetValue(r.ResourceId, out var found) ? found : null;
                PersonnelPool? p = r.ResourceType == ResourceType.PersonnelPool && pools.TryGetValue(r.ResourceId, out var group) ? group : null;
                if ((v is null && p is null) || !seen.Add(r.ResourceId)) continue; // um meio só faz uma coisa de cada vez: o que o plano lhe pede primeiro
                timelines.Add(Timeline(plan, action, r, v, p, site, scenarioStart, durationMinutes, stations, rules, defaultWindowMinutes));
            }
        }
        return timelines;
    }

    static UnitTimeline Timeline(Plan plan, PlanAction action, ResourceAssignment r, Vehicle? v, PersonnelPool? p, LatLon site, DateTimeOffset scenarioStart, int duration,
        IReadOnlyDictionary<string, LatLon> stations, Rules rules, int window)
    {
        string? stationId = r.FromStationId ?? v?.StationId ?? p?.StationId;
        LatLon home = stationId is not null && stations.TryGetValue(stationId, out var s) ? s
            : r.Route is { NumPoints: > 1 } first ? new LatLon(first.Coordinates[0].Y, first.Coordinates[0].X) : site;
        double eta = Math.Max(0, r.EtaMinutes ?? 0);
        var route = r.Route is { NumPoints: > 1 } own ? own : Gf.CreateLineString(new[] { new Coordinate(home.Lon, home.Lat), new Coordinate(site.Lon, site.Lat) });
        var back = (LineString)route.Reverse();

        double departAt = PlanTiming.StartAt(plan, action) is { } at ? (at - scenarioStart).TotalMinutes : PlanTiming.StartMinutes(plan, action);
        int depart = (int)Math.Round(Math.Max(0, departAt));
        double arrive = depart + eta, until = arrive + (action.ExpectedDurationMinutes ?? window), backAt = until + eta;

        bool aerial = v is not null && ArrivalEstimator.IsAerial(v.Type);
        double water = aerial ? 0 : v?.WaterCapacityL ?? 0, pump = aerial ? 0 : v?.PumpFlowLpm ?? 0, duty = rules.Water.DutyCycle;
        var segments = CrewWorkSchedule.Plan(arrive, until, water, pump, rules);
        double perFill = water > 0 && pump > 0 && duty > 0 ? water / (pump * duty) : double.PositiveInfinity;
        bool refills = double.IsFinite(perFill);
        double rest = rules.Crews.MandatoryRestMinutes;

        var points = new List<UnitTrackPoint>();
        double fatigue = 0;
        for (int m = 0; m <= duration; m++)
        {
            DispatchStatus status; var position = home; double? level = water > 0 ? water : null;
            if (m < depart) status = DispatchStatus.Ordered;
            else if (m < arrive) { status = DispatchStatus.EnRoute; position = CrewSafety.PositionAt(route, eta, site, m - depart); }
            else if (m >= backAt) status = DispatchStatus.Completed;
            else if (m >= until) { status = DispatchStatus.Returning; position = CrewSafety.PositionAt(back, eta, home, m - until); }
            else
            {
                position = site;
                var now = segments.FirstOrDefault(sg => m >= sg.FromMinute && m < sg.FromMinute + sg.Minutes);
                if (now is not null)
                {
                    status = DispatchStatus.Working;
                    fatigue = (1 - now.Fatigue) * 100;
                    if (refills) level = Math.Max(0, water * (1 - (m - now.FromMinute) / perFill));
                }
                else
                {
                    var before = segments.LastOrDefault(sg => sg.FromMinute + sg.Minutes <= m);
                    var after = segments.FirstOrDefault(sg => sg.FromMinute > m);
                    if (before is null || after is null) status = DispatchStatus.OnScene; // chegou e ainda não começou, ou acabou a última janela e espera pelo fim da ação
                    else
                    {
                        double gap = after.FromMinute - (before.FromMinute + before.Minutes);
                        status = gap >= rest - 1e-9 ? DispatchStatus.Resting : DispatchStatus.Refilling;
                        if (status == DispatchStatus.Refilling && water > 0) level = water * (m - (before.FromMinute + before.Minutes)) / gap;
                    }
                }
            }
            points.Add(new UnitTrackPoint(m, status, position, level, Math.Round(fatigue, 1)));
        }

        var events = new List<UnitEvent>();
        void Add(double minute, string type, LatLon? where, string? detail = null) { if (minute <= duration) events.Add(new((int)Math.Round(minute), type, where, detail)); }
        Add(depart, "departed", home);
        Add(arrive, "arrived", site);
        if (segments.Count > 0) Add(segments[0].FromMinute, "started_working", site);
        for (int i = 0; i + 1 < segments.Count; i++)
        {
            double end = segments[i].FromMinute + segments[i].Minutes, next = segments[i + 1].FromMinute;
            if (next - end >= rest - 1e-9) { Add(end, "rest_started", site); Add(next, "rest_done", site); }
            else { Add(end, "water_empty", site); Add(end, "refill_started", site, "viatura vai reabastecer"); Add(next, "refill_done", site); }
        }
        Add(backAt, "returned", home);

        string callsign = v?.Callsign ?? $"Equipa {r.ResourceId}";
        return new UnitTimeline(r.ResourceId, r.ResourceType, callsign, v?.OrganizationId ?? p?.OrganizationId ?? "", action.Id, r.Responsibility, new Target(Label: action.Title, Position: site),
            r.Personnel ?? v?.CrewCapacity ?? p?.Available ?? 0, water > 0 ? water : null, water > 0 && pump > 0 ? pump * duty : null, (int)Math.Round(arrive), points, events.OrderBy(e => e.TMin).ToList());
    }

    /// <summary>O estado de um meio ao minuto `t` (o último minuto simulado se `t` passar do fim).</summary>
    public static UnitState StateAt(UnitTimeline u, int t)
    {
        int at = Math.Clamp(t, 0, u.Points.Count - 1);
        var point = u.Points[at];
        int worked = u.Points.Take(at + 1).Count(x => x.Status == DispatchStatus.Working);
        return new UnitState(u.UnitId, point.Status, u.ResourceType, u.Callsign, u.OrganizationId, null, u.Responsibility, point.Position, u.Target,
            point.Status == DispatchStatus.EnRoute ? Math.Max(0, u.ArrivesAtMinute - at) : null, u.Personnel,
            u.WaterCapacityL is > 0 ? new WaterStatus(LevelL: point.WaterLevelL, CapacityL: u.WaterCapacityL, ConsumptionLpm: u.ConsumptionLpm) : null,
            new CrewStatus(WorkedMinutes: worked, FatiguePct: point.FatiguePct));
    }

    async Task<(FireRun Run, Plan? Plan)> ContextAsync(string simulationId, CancellationToken ct)
    {
        var simulation = await simulations.GetAsync(simulationId, ct) ?? throw new NotFoundException($"Simulação '{simulationId}'");
        if (simulation.Status != SimulationStatus.Succeeded) throw new ConflictException($"A simulação '{simulationId}' está '{EnumText.ToSnake(simulation.Status)}'.", "simulation_not_ready");
        var run = await runs.GetAsync(simulationId, ct) ?? throw new NotFoundException($"Resultado da simulação '{simulationId}'");
        var plan = simulation.PlanId is { } planId ? await plans.GetAsync(planId, ct) : null;
        return (run, plan);
    }

    async Task<List<Demand>> DemandsAsync(Plan plan, FireRun run, CancellationToken ct)
    {
        var demands = new List<Demand>();
        foreach (var action in plan.Actions)
        {
            if (action.Resources is not { Count: > 0 }) continue;
            var target = PlanService.TargetOf(action);
            if (target.IsEmpty || await targets.PositionAsync(target, plan.LocationId, ct) is not { } site) continue;
            var start = Math.Max(0, PlanTiming.StartMinutes(plan, action));
            var duration = Math.Max(1, action.ExpectedDurationMinutes ?? settings.Limits.DefaultActionWindowMinutes);

            foreach (var assignment in action.Resources.Where(r => r.ResourceType != ResourceType.Equipment))
            {
                if (demands.Any(d => d.UnitId == assignment.ResourceId)) continue; // one track per resource, the first action wins
                var vehicle = assignment.ResourceType == ResourceType.Vehicle ? await vehicles.GetAsync(assignment.ResourceId, ct) : null;
                var pool = assignment.ResourceType == ResourceType.PersonnelPool ? await pools.GetAsync(assignment.ResourceId, ct) : null;
                if (vehicle is null && pool is null) continue;

                LineString? route = assignment.Route;
                double eta = assignment.EtaMinutes ?? 0;
                LatLon? origin = null;
                if (vehicle is not null)
                {
                    var estimate = await arrival.ForActionAsync(plan, action, vehicle, assignment, ct);
                    if (eta <= 0 && estimate?.Minutes is { } minutes) eta = minutes;
                    route ??= estimate?.Route;
                    origin = await arrival.OriginAsync(vehicle, assignment.FromStationId, ct);
                }
                else if (pool is not null && pool.StationId is { } stationId)
                {
                    origin = (await stations.GetAsync(stationId, ct))?.Position;
                }

                eta = Math.Max(0, eta);
                var capacity = vehicle?.WaterCapacityL ?? 0;
                var pump = vehicle?.PumpFlowLpm ?? 0;
                var ruleConsumption = double.TryParse(settings.Rules.Water.ConsumptionLpm, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
                var perMinute = vehicle is not null && capacity > 0
                    ? Math.Max(1, pump > 0 ? pump : ruleConsumption) * settings.Rules.Water.DutyCycle
                    : 0;
                var workStart = start + eta;

                demands.Add(new Demand(
                    assignment.ResourceId,
                    assignment.ResourceType,
                    vehicle?.Callsign ?? (pool?.Role.ToString()),
                    vehicle?.OrganizationId ?? pool?.OrganizationId ?? action.OrganizationId,
                    assignment.Responsibility,
                    assignment.Personnel ?? vehicle?.CrewCapacity ?? 1,
                    target,
                    site,
                    vehicle,
                    pool,
                    route,
                    origin,
                    start,
                    eta,
                    workStart,
                    workStart + duration,
                    workStart + duration + eta,
                    capacity,
                    perMinute,
                    vehicle is not null && ArrivalEstimator.IsAerial(vehicle.Type)));
            }
        }

        // Older plans (and plans activated through the dispatch API) carry their resources on dispatches, not on actions.
        foreach (var dispatch in (await dispatches.ListAsync(ct)).Where(d => d.PlanId == plan.Id && d.ResourceType != ResourceType.Equipment))
        {
            if (demands.Any(d => d.UnitId == dispatch.ResourceId)) continue;
            if (dispatch.Target.IsEmpty || await targets.PositionAsync(dispatch.Target, plan.LocationId, ct) is not { } site) continue;
            var vehicle = dispatch.ResourceType == ResourceType.Vehicle ? await vehicles.GetAsync(dispatch.ResourceId, ct) : null;
            var pool = dispatch.ResourceType == ResourceType.PersonnelPool ? await pools.GetAsync(dispatch.ResourceId, ct) : null;
            if (vehicle is null && pool is null) continue;

            var action = dispatch.ActionId is { } actionId ? plan.Actions.FirstOrDefault(a => a.Id == actionId) : null;
            var start = Math.Max(0, action is null ? 0 : PlanTiming.StartMinutes(plan, action));
            if (dispatch.StartAt is { } at)
            {
                // A dispatch created by the operator carries the wall-clock activation time. If it sits outside the
                // scenario window (a historical exercise, for instance), anchor it to T+0 instead of hiding the unit.
                var relative = (at - run.Start).TotalMinutes;
                if (relative >= 0 && relative <= run.DurationMinutes) start = relative;
            }
            var duration = Math.Max(1, dispatch.ExpectedDurationMinutes ?? action?.ExpectedDurationMinutes ?? settings.Limits.DefaultActionWindowMinutes);
            var origin = vehicle is not null
                ? await arrival.OriginAsync(vehicle, dispatch.FromStationId, ct)
                : pool?.StationId is { } stationId ? (await stations.GetAsync(stationId, ct))?.Position : null;
            var estimate = vehicle is not null && origin is not null
                ? await arrival.EstimateAsync(vehicle, origin, site, plan.LocationId, dispatch.StartAt, ct)
                : null;
            var eta = Math.Max(0, dispatch.EtaMinutes ?? estimate?.Minutes ?? 0);
            var route = dispatch.Route ?? estimate?.Route;
            var capacity = vehicle?.WaterCapacityL ?? 0;
            var pump = vehicle?.PumpFlowLpm ?? 0;
            var ruleConsumption = double.TryParse(settings.Rules.Water.ConsumptionLpm, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
            var perMinute = vehicle is not null && capacity > 0
                ? Math.Max(1, pump > 0 ? pump : ruleConsumption) * settings.Rules.Water.DutyCycle
                : 0;
            var workStart = start + eta;

            demands.Add(new Demand(
                dispatch.ResourceId,
                dispatch.ResourceType,
                vehicle?.Callsign ?? pool?.Role.ToString(),
                vehicle?.OrganizationId ?? pool?.OrganizationId ?? dispatch.OrganizationId,
                dispatch.Responsibility,
                dispatch.Personnel > 0 ? dispatch.Personnel : vehicle?.CrewCapacity ?? 1,
                dispatch.Target,
                site,
                vehicle,
                pool,
                route,
                origin,
                start,
                eta,
                workStart,
                workStart + duration,
                workStart + duration + eta,
                capacity,
                perMinute,
                vehicle is not null && ArrivalEstimator.IsAerial(vehicle.Type)));
        }
        return demands;
    }

    UnitState StateAt(Demand d, int minute, FireRun run)
    {
        var status = StatusAt(d, minute);
        var working = status is DispatchStatus.Working or DispatchStatus.Refilling or DispatchStatus.Resting;
        var work = working ? WorkAt(d, minute) : null;
        var water = d.WaterCapacityL > 0 && d.Vehicle is not null
            ? new WaterStatus(
                work?.WaterL ?? d.WaterCapacityL,
                d.WaterCapacityL,
                d.WaterPerMinuteL,
                EmptyAtMinute: work?.EmptyAtMinute)
            : null;
        var crew = d.Personnel > 0
            ? new CrewStatus(
                work?.WorkedMinutes ?? 0,
                work?.FatiguePct ?? 0,
                run.Start.AddHours(settings.Rules.Crews.ShiftLengthHours),
                run.Start.AddMinutes(settings.Rules.Crews.MaxContinuousWorkMinutes))
            : null;
        var aerial = d.Aerial
            ? new AerialStatus(
                Drops: (int)((work?.WorkedMinutes ?? 0) / Math.Max(1, (d.Vehicle?.Aerial?.LoadMinutes ?? 0) + (d.Vehicle?.Aerial?.DropMinutes ?? 0))),
                WaterDeliveredL: (int)((work?.WorkedMinutes ?? 0) / Math.Max(1, (d.Vehicle?.Aerial?.LoadMinutes ?? 0) + (d.Vehicle?.Aerial?.DropMinutes ?? 0)))
                    * (d.Vehicle?.Aerial?.BucketCapacityL ?? 0),
                CycleMinutes: (d.Vehicle?.Aerial?.LoadMinutes ?? 0) + (d.Vehicle?.Aerial?.DropMinutes ?? 0),
                BlockedBy: null)
            : null;

        return new UnitState(
            d.UnitId,
            status,
            d.ResourceType,
            d.Callsign,
            d.OrganizationId,
            DispatchId: null,
            d.Responsibility,
            PositionAt(d, minute),
            d.Target,
            d.Eta,
            d.Personnel,
            water,
            crew,
            aerial);
    }

    UnitTrackPoint PointAt(Demand d, int minute, FireRun run)
    {
        var status = StatusAt(d, minute);
        var work = status is DispatchStatus.Working or DispatchStatus.Refilling or DispatchStatus.Resting ? WorkAt(d, minute) : null;
        return new UnitTrackPoint(minute, status, PositionAt(d, minute), work?.WaterL, work?.FatiguePct);
    }

    DispatchStatus StatusAt(Demand d, double minute)
    {
        if (minute < d.Start) return DispatchStatus.Ordered;
        if (minute < d.WorkStart) return DispatchStatus.EnRoute;
        if (minute < d.WorkEnd) return WorkAt(d, minute).Status;
        if (minute < d.ReturnEnd) return DispatchStatus.Returning;
        return DispatchStatus.Completed;
    }

    LatLon? PositionAt(Demand d, double minute)
    {
        if (minute < d.Start) return null;
        if (minute < d.WorkStart)
        {
            if (d.Route is not null) return CrewSafety.PositionAt(d.Route, d.Eta, d.Site, minute - d.Start);
            return d.Origin is { } origin ? Lerp(origin, d.Site, d.Eta <= 0 ? 1 : (minute - d.Start) / d.Eta) : d.Site;
        }
        if (minute < d.WorkEnd) return d.Site;
        if (minute < d.ReturnEnd)
        {
            if (d.Route is not null) return CrewSafety.PositionAt(d.Route, d.Eta, d.Site, Math.Max(0, d.Eta - (minute - d.WorkEnd)));
            var f = d.Eta <= 0 ? 0 : 1 - (minute - d.WorkEnd) / d.Eta;
            return d.Origin is { } origin ? Lerp(origin, d.Site, f) : d.Site;
        }
        return d.Origin ?? d.Site;
    }

    static LatLon Lerp(LatLon from, LatLon to, double fraction)
    {
        var f = Math.Clamp(fraction, 0, 1);
        return new LatLon(from.Lat + (to.Lat - from.Lat) * f, from.Lon + (to.Lon - from.Lon) * f);
    }

    WorkState WorkAt(Demand d, double minute)
    {
        var elapsed = Math.Max(0, minute - d.WorkStart);
        var capacity = d.WaterCapacityL;
        var perMinute = d.WaterPerMinuteL;
        var refillMinutes = Math.Max(1, (int)Math.Ceiling(settings.Rules.Water.Refill.ShuttleMinutes + settings.Rules.Water.Refill.SetupMinutes));
        var restMinutes = Math.Max(1, settings.Rules.Crews.MandatoryRestMinutes);
        var maxWork = Math.Max(1, settings.Rules.Crews.MaxContinuousWorkMinutes);

        if (d.Aerial || capacity <= 0 || perMinute <= 0)
        {
            var workedOnly = (int)Math.Floor(elapsed);
            return new WorkState(DispatchStatus.Working, capacity, workedOnly, Fatigue(workedOnly), null);
        }

        var water = capacity;
        var worked = 0;
        var sinceRest = 0;
        var phase = DispatchStatus.Working;
        var remaining = 0;
        int? emptyAt = null;

        for (int i = 0; i < (int)Math.Floor(elapsed); i++)
        {
            if (phase is DispatchStatus.Refilling or DispatchStatus.Resting)
            {
                remaining--;
                if (remaining <= 0) phase = DispatchStatus.Working;
                continue;
            }

            worked++;
            sinceRest++;
            water = Math.Max(0, water - perMinute);
            if (water <= 0)
            {
                emptyAt ??= (int)Math.Floor(d.WorkStart + i + 1);
                phase = DispatchStatus.Refilling;
                remaining = refillMinutes;
                continue;
            }
            if (sinceRest >= maxWork)
            {
                phase = DispatchStatus.Resting;
                remaining = restMinutes;
            }
        }

        if (phase == DispatchStatus.Working && water <= 0)
        {
            // the first minute of work can empty a very small tank; report the refill already
            emptyAt ??= (int)Math.Floor(d.WorkStart + Math.Floor(elapsed));
            phase = DispatchStatus.Refilling;
        }

        return new WorkState(phase, phase == DispatchStatus.Refilling ? 0 : water, worked, Fatigue(worked), emptyAt);
    }

    double Fatigue(int workedMinutes) => Math.Min(100, workedMinutes / 60.0 * settings.Rules.Crews.FatiguePctPerHour);

    IReadOnlyList<UnitEvent> Events(Demand d, FireRun run)
    {
        var events = new List<UnitEvent>();
        Add(events, (int)Math.Round(d.Start), "departed", null, run);
        if (d.Eta > 0) Add(events, (int)Math.Round(d.WorkStart), "arrived", d.Site, run);
        Add(events, (int)Math.Round(d.WorkStart), "started_working", d.Site, run);

        var previous = WorkAt(d, d.WorkStart);
        for (int minute = (int)Math.Ceiling(d.WorkStart) + 1; minute < d.WorkEnd; minute++)
        {
            var current = WorkAt(d, minute);
            if (previous.Status != current.Status)
            {
                if (current.Status == DispatchStatus.Refilling) Add(events, minute, "refill_started", d.Site, run);
                else if (current.Status == DispatchStatus.Resting) Add(events, minute, "rest_started", d.Site, run);
                else if (previous.Status == DispatchStatus.Refilling) Add(events, minute, "refill_done", d.Site, run);
                else if (previous.Status == DispatchStatus.Resting) Add(events, minute, "rest_done", d.Site, run);
            }
            if (previous.WaterL > 0 && current.WaterL <= 0) Add(events, minute, "water_empty", d.Site, run);
            previous = current;
        }

        Add(events, (int)Math.Round(d.ReturnEnd), "returned", d.Origin ?? d.Site, run);
        return events.OrderBy(e => e.TMin).ThenBy(e => e.Type, StringComparer.Ordinal).ToList();
    }

    void Add(List<UnitEvent> events, int tMin, string type, LatLon? position, FireRun run)
    {
        if (tMin < 0 || tMin > run.DurationMinutes) return;
        if (events.Any(e => e.TMin == tMin && e.Type == type)) return;
        events.Add(new UnitEvent(tMin, type, position));
    }
}
