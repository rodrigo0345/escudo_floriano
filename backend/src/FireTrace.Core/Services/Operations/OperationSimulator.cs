using System.Collections.Concurrent;
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
using FireTrace.Core.Models.Routing;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Map;
using FireTrace.Core.Services.Routing;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// Simula a execução de um plano minuto a minuto: cada viatura sai do seu posto, segue a rota **por estrada**, pára onde a estrada acaba (a equipa avança a pé com as
/// mangueiras) e trabalha; quando fica sem água vai por estrada ao ponto de água mais rápido de alcançar e volta, quando o depósito baixa vai abastecer ao posto mais perto,
/// descansa quando tem de descansar (<see cref="UnitDuty"/>). Um meio com várias ações no plano faz-as **todas, por ordem**: acabada uma, vai por estrada (ou pelo ar) para a
/// seguinte com a água e o combustível que tem, e só no fim regressa ao posto. Uma viatura terrestre sem estrada até ao alvo não sai (`failed`): nunca atravessa o monte em
/// linha reta. É determinístico e não altera o fogo: o resultado é a base de `GET /simulations/{id}/units` e `/units/{unitId}/track`.
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
    MapQueries map,
    RoutingService routing,
    FireTraceSettings settings)
{
    /// <summary>Um meio do plano: o que é, para onde vai primeiro, e tudo o que faz minuto a minuto (<see cref="Trace"/>).</summary>
    sealed record Demand(string UnitId, ResourceType ResourceType, string? Callsign, string OrganizationId, Responsibility? Responsibility, int Personnel, Target Target, Vehicle? Vehicle,
        double Eta, double WaterCapacityL, double WaterLpm, double FuelCapacityL, bool Aerial, Trace Trace);

    /// <summary>
    /// Uma ação de um meio: a partir de quando pode partir, quanto demora a chegar e por onde (do sítio onde estava: o posto na primeira, a ação anterior nas
    /// seguintes), onde atua, quanto tempo trabalha, e onde vai buscar água e combustível a partir dali.
    /// </summary>
    public sealed record Leg(double Start, double Eta, double WorkMinutes, LineString? Route, LatLon Site, UnitDuty.Trip? Water = null, UnitDuty.Trip? Fuel = null, string? Label = null);

    /// <summary>A pista de um meio: um ponto por minuto, os acontecimentos, os troços de trabalho (para saber onde reabastece) e, por ação, a partida e a chegada.</summary>
    public sealed record Trace(IReadOnlyList<UnitTrackPoint> Points, IReadOnlyList<UnitEvent> Events, IReadOnlyList<UnitDuty.Segment> Segments, IReadOnlyList<(int Depart, int Arrive)> Legs)
    {
        public int ArrivesAtMinute => Legs.Count > 0 ? Legs[0].Arrive : 0;
    }

    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);

    // Os meios de um plano calculam-se uma vez: a interface pede a pista de cada meio (N pedidos) e cada um voltava a encaminhar todos os meios e todas as idas à água.
    readonly ConcurrentDictionary<string, Lazy<Task<List<Demand>>>> _demands = new();
    readonly ConcurrentDictionary<string, Lazy<Task<UnitDuty.Trip?>>> _trips = new();
    const int MaxRememberedPlans = 32, MaxRememberedTrips = 5_000;
    const double SameSpotM = 500; // a rota que o plano traz para uma ação seguinte só serve se partir de onde o meio está

    public async Task<UnitStateList> UnitsAsync(string simulationId, int tMin, string? organizationId, string? responsibility, CancellationToken ct)
    {
        var (run, plan) = await ContextAsync(simulationId, ct);
        var demands = plan is null ? new List<Demand>() : await DemandsAsync(simulationId, plan, run, ct);
        var wanted = responsibility?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var items = demands
            .Where(d => organizationId is null || d.OrganizationId == organizationId)
            .Where(d => wanted is null || wanted.Length == 0 || (d.Responsibility is { } r && wanted.Contains(EnumText.ToSnake(r))))
            .OrderBy(d => d.UnitId, StringComparer.Ordinal)
            .Select(d => StateOf(d, tMin, run))
            .ToList();
        return new UnitStateList(simulationId, tMin, items);
    }

    public async Task<UnitTrack> TrackAsync(string simulationId, string unitId, int stepMin, CancellationToken ct)
    {
        var (run, plan) = await ContextAsync(simulationId, ct);
        var demands = plan is null ? new List<Demand>() : await DemandsAsync(simulationId, plan, run, ct);
        var demand = demands.FirstOrDefault(d => d.UnitId == unitId) ?? throw new NotFoundException($"Meio '{unitId}' na simulação '{simulationId}'");
        var step = Math.Clamp(stepMin, 1, 60);
        var all = demand.Trace.Points;
        var points = new List<UnitTrackPoint>();
        for (int t = 0; t < all.Count; t += step) points.Add(all[t]);
        if (points.Count > 0 && points[^1].TMin != all[^1].TMin) points.Add(all[^1]);
        return new UnitTrack(simulationId, unitId, step, points, demand.Trace.Events);
    }

    /// <summary>
    /// The pure part of the simulator, for callers that have already loaded the plan's resources: what each unit does in its first action, minute by minute, without
    /// touching the database (no trips to water or fuel are routed here: a unit that runs dry refills with the rules' generic shuttle where it works). The injected
    /// <see cref="UnitsAsync"/> and <see cref="TrackAsync"/> add the later actions of each unit, the routing of the trips, the plan/dispatch persistence and the HTTP filters.
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
                if ((v is null && p is null) || !seen.Add(r.ResourceId)) continue; // aqui, só a primeira ação de cada meio

                string? stationId = r.FromStationId ?? v?.StationId ?? p?.StationId;
                LatLon home = stationId is not null && stations.TryGetValue(stationId, out var s) ? s
                    : r.Route is { NumPoints: > 1 } first ? new LatLon(first.Coordinates[0].Y, first.Coordinates[0].X) : site;
                double eta = Math.Max(0, r.EtaMinutes ?? 0);
                double departAt = PlanTiming.StartAt(plan, action) is { } at ? (at - scenarioStart).TotalMinutes : PlanTiming.StartMinutes(plan, action);
                var (capacity, lpm) = WaterOf(v, rules);
                UnitDuty.Trip? waterTrip = null;
                if (v is not null && ArrivalEstimator.IsAerial(v.Type) && capacity > 0)
                {
                    double speed = v.CruiseSpeedKmh ?? v.Aerial?.CruiseSpeedKmh ?? rules.Aerial.Helicopter.CruiseSpeedKmh;
                    double flightMin = Math.Max(0.5, 2000.0 / (speed * 1000.0 / 60.0));
                    double loadMin = v.Aerial?.LoadMinutes ?? 1.0;
                    var waterPos = new LatLon(site.Lat + 0.015, site.Lon + 0.015);
                    waterTrip = new UnitDuty.Trip(RoutePath.Of(Line(site, waterPos)), flightMin, loadMin, "water-default", "Ponto de Água", waterPos);
                }
                var leg = new Leg(Math.Round(Math.Max(0, departAt)), eta, action.ExpectedDurationMinutes ?? defaultWindowMinutes, r.Route is { NumPoints: > 1 } own ? own : null, site, waterTrip);
                var back = leg.Route is { } route ? (LineString)route.Reverse() : null;
                var trace = Build(durationMinutes, new[] { leg }, home, back, eta, v, rules);
                string callsign = v?.Callsign ?? $"Equipa {r.ResourceId}";
                timelines.Add(new UnitTimeline(r.ResourceId, r.ResourceType, callsign, v?.OrganizationId ?? p?.OrganizationId ?? "", action.Id, r.Responsibility, new Target(Label: action.Title, Position: site),
                    r.Personnel ?? v?.CrewCapacity ?? p?.Available ?? 0, capacity > 0 ? capacity : null, capacity > 0 && lpm > 0 ? lpm : null, trace.ArrivesAtMinute, trace.Points, trace.Events));
            }
        }
        return timelines;
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

    // ------------------------------------------------------------------------------------------------------------ the trace

    /// <summary>Uma passagem sobre o alvo: o meio aéreo dá voltas à volta do ponto (cerca de 200 m), em vez de pairar parado num só ponto.</summary>
    static LatLon Orbit(LatLon site, int minute)
    {
        double angle = minute * 2.4, radiusM = 200;
        return new LatLon(site.Lat + radiusM / 111_320.0 * Math.Sin(angle), site.Lon + radiusM / (111_320.0 * Math.Cos(site.Lat * Math.PI / 180)) * Math.Cos(angle));
    }

    static LineString Line(LatLon a, LatLon b) => Gf.CreateLineString(new[] { new Coordinate(a.Lon, a.Lat), new Coordinate(b.Lon, b.Lat) });

    static LatLon EndOf(LineString route) => new(route.Coordinates[^1].Y, route.Coordinates[^1].X);

    static LatLon StartOf(LineString route) => new(route.Coordinates[0].Y, route.Coordinates[0].X);

    static (double CapacityL, double Lpm) WaterOf(Vehicle? v, Rules rules) =>
        v is null ? (0, 0)
        : ArrivalEstimator.IsAerial(v.Type) ? (v.WaterCapacityL ?? (v.Aerial?.BucketCapacityL ?? 1000), (v.WaterCapacityL ?? (v.Aerial?.BucketCapacityL ?? 1000)) / Math.Max(0.5, v.Aerial?.DropMinutes ?? 1.0))
        : (v.WaterCapacityL ?? 0, rules.Water.WorkingLpm(v.PumpFlowLpm ?? 0));

    static (double CapacityL, double PerKm) FuelOf(Vehicle? v, Rules rules)
    {
        if (v is null || ArrivalEstimator.IsAerial(v.Type)) return (0, 0);
        double capacity = v.FuelCapacityL is > 0 ? v.FuelCapacityL.Value : rules.Fuel.DefaultCapacityL;
        double perKm = v.FuelCapacityL is > 0 && v.RangeKm is > 0 ? v.FuelCapacityL.Value / v.RangeKm.Value : rules.Fuel.DrivingLPer100Km / 100;
        return (capacity, perKm);
    }

    enum PieceKind { Travel, Work, Wait, Return }

    /// <summary>Um bocado da vida do meio: a viajar (por um percurso), a trabalhar numa ação (com os troços do <see cref="UnitDuty"/>) ou à espera no local.</summary>
    sealed record Piece(PieceKind Kind, double From, double To, RoutePath? Path, LatLon Place, LatLon Site, double WaterFrom, double FuelFrom, double FuelTo, double Until,
        IReadOnlyList<UnitDuty.Segment> Segments);

    /// <summary>
    /// Tudo o que o meio faz, minuto a minuto, nas suas ações por ordem, e o regresso ao posto pelo percurso `back` (em `backEta` minutos). A rota de cada ação vai de onde
    /// o meio está até onde pára (o fim da estrada); numa viatura terrestre sem rota a ação não se faz (sem estrada até lá) e, se for a primeira, a viatura não sai.
    /// Um meio aéreo ou um grupo de pessoal trabalha no próprio sítio da ação, sem água nem combustível contados aqui.
    /// </summary>
    static Trace Build(int duration, IReadOnlyList<Leg> legs, LatLon home, LineString? back, double backEta, Vehicle? v, Rules rules)
    {
        bool aerial = v is not null && ArrivalEstimator.IsAerial(v.Type), ground = v is not null && !aerial;
        var points = new List<UnitTrackPoint>(duration + 1);
        var events = new List<UnitEvent>();
        void Add(double minute, string type, LatLon? where, string? detail = null)
        {
            int m = (int)Math.Round(minute);
            if (m < 0 || m > duration || events.Any(e => e.TMin == m && e.Type == type)) return;
            events.Add(new UnitEvent(m, type, where, detail));
        }

        var doable = legs.Where(l => !ground || l.Route is { NumPoints: > 1 }).ToList();
        if (doable.Count == 0)
        {
            // sem estrada até ao alvo a viatura não vai: nunca anda pelo mato em linha reta
            double at = legs.Count > 0 ? Math.Round(Math.Max(0, legs[0].Start)) : 0;
            for (int m = 0; m <= duration; m++) points.Add(new UnitTrackPoint(m, m < at ? DispatchStatus.Ordered : DispatchStatus.Failed, home));
            Add(at, "withdrawn", home, "sem estrada até ao alvo: a viatura não sai");
            return new Trace(points, events, Array.Empty<UnitDuty.Segment>(), Array.Empty<(int, int)>());
        }

        var (waterCap, lpm) = WaterOf(v, rules);
        var (fuelCap, perKm) = FuelOf(v, rules);
        double water = waterCap, fuel = fuelCap * Math.Clamp(v?.State.FuelPct ?? 100, 0, 100) / 100;
        double fuelStart = fuel;
        var pieces = new List<Piece>();
        var legTimes = new List<(int Depart, int Arrive)>();
        var allSegments = new List<UnitDuty.Segment>();
        LatLon here = home;
        double free = 0;
        for (int i = 0; i < doable.Count; i++)
        {
            var leg = doable[i];
            var route = ground ? leg.Route! : i == 0 && leg.Route is { NumPoints: > 1 } own ? own : Line(here, leg.Site);
            var path = RoutePath.Of(route);
            var park = ground ? EndOf(route) : leg.Site; // a viatura pára onde a estrada acaba
            double depart = i == 0 ? Math.Round(Math.Max(0, leg.Start)) : Math.Max(leg.Start, free);
            if (i > 0 && depart > free) pieces.Add(new Piece(PieceKind.Wait, free, depart, null, here, here, water, fuel, fuel, depart, Array.Empty<UnitDuty.Segment>()));
            double km = (path?.TotalM ?? 0) / 1000, arrive = depart + Math.Max(0, leg.Eta);
            pieces.Add(new Piece(PieceKind.Travel, depart, arrive, path, park, leg.Site, water, fuel, Math.Max(0, fuel - km * perKm), arrive, Array.Empty<UnitDuty.Segment>()));
            fuel = Math.Max(0, fuel - km * perKm);
            double until = arrive + Math.Max(1, leg.WorkMinutes);
            var segments = ground
                ? UnitDuty.Plan(arrive, until, new UnitDuty.Inputs(waterCap, lpm, leg.Water, rules.Water.Refill.ShuttleMinutes + rules.Water.Refill.SetupMinutes, fuelCap,
                    fuel, perKm, rules.Fuel.WorkingLph / 60, fuelCap * rules.Fuel.RefuelBelowPct / 100, leg.Fuel, water), rules.Crews)
                : aerial && waterCap > 0
                ? UnitDuty.Plan(arrive, until, new UnitDuty.Inputs(waterCap, lpm, leg.Water, (leg.Water?.Minutes ?? 3.0) * 2.0 + (leg.Water?.StopMinutes ?? 1.0), 0,
                    0, 0, 0, 0, null, water), rules.Crews)
                : Array.Empty<UnitDuty.Segment>();
            double end = Math.Max(until, segments.Count > 0 ? segments[^1].To : until);
            pieces.Add(new Piece(PieceKind.Work, arrive, end, null, park, leg.Site, water, fuel, fuel, until, segments));
            allSegments.AddRange(segments);
            if (segments.Count > 0) { water = segments[^1].WaterTo; fuel = segments[^1].FuelTo; }
            legTimes.Add(((int)Math.Round(depart), (int)Math.Round(arrive)));

            Add(depart, "departed", here, i == 0 ? null : $"segue para: {leg.Label}");
            Add(arrive, "arrived", park, leg.Label);
            if (!ground) Add(arrive, "started_working", leg.Site);
            here = park;
            free = end;
        }
        var backRoute = back is { NumPoints: > 1 } ? back : Line(here, home);
        var backPath = RoutePath.Of(backRoute);
        double backKm = (backPath?.TotalM ?? 0) / 1000, backAt = free + Math.Max(0, backEta);
        pieces.Add(new Piece(PieceKind.Return, free, backAt, backPath, home, home, water, fuel, Math.Max(0, fuel - backKm * perKm), backAt, Array.Empty<UnitDuty.Segment>()));
        double fuelHome = Math.Max(0, fuel - backKm * perKm);

        double maxFatigue = 100 - rules.Crews.MinimumEffectivenessPct;
        double? Pct(double litres) => fuelCap > 0 ? Math.Round(Math.Clamp(litres / fuelCap * 100, 0, 100), 1) : null;
        double? Water(double litres) => waterCap > 0 ? Math.Round(litres, 1) : null;
        double firstDepart = pieces[0].From;
        int workedNoDuty = 0, p = 0;
        double fatigueNow = 0; // a equipa leva o cansaço de uma ação para a seguinte
        for (int m = 0; m <= duration; m++)
        {
            if (m < firstDepart) { points.Add(new UnitTrackPoint(m, DispatchStatus.Ordered, home, Water(waterCap), 0, Pct(fuelStart))); continue; }
            while (p < pieces.Count - 1 && m >= pieces[p].To) p++;
            var piece = pieces[p];
            if (m >= piece.To) { points.Add(new UnitTrackPoint(m, DispatchStatus.Completed, home, null, null, Pct(fuelHome))); continue; } // depois do regresso
            double f = piece.To - piece.From <= 0 ? 1 : (m - piece.From) / (piece.To - piece.From);
            double fuelHere = piece.FuelFrom + (piece.FuelTo - piece.FuelFrom) * f;
            switch (piece.Kind)
            {
                case PieceKind.Travel:
                    points.Add(new UnitTrackPoint(m, DispatchStatus.EnRoute, CrewSafety.PositionOn(piece.Path, piece.To - piece.From, piece.Place, m - piece.From), Water(piece.WaterFrom), Math.Round(fatigueNow, 1), Pct(fuelHere)));
                    break;
                case PieceKind.Return:
                    points.Add(new UnitTrackPoint(m, DispatchStatus.Returning, CrewSafety.PositionOn(piece.Path, piece.To - piece.From, home, m - piece.From), null, null, Pct(fuelHere)));
                    break;
                case PieceKind.Wait:
                    points.Add(new UnitTrackPoint(m, DispatchStatus.OnScene, piece.Place, Water(piece.WaterFrom), Math.Round(fatigueNow, 1), Pct(piece.FuelFrom)));
                    break;
                case PieceKind.Work when !ground && piece.Segments.Count == 0:
                    // grupos de pessoal sem água: no sítio da ação durante a janela, a cansar-se
                    bool working = m < piece.Until;
                    if (working) workedNoDuty++;
                    fatigueNow = Math.Min(maxFatigue, workedNoDuty / 60.0 * rules.Crews.FatiguePctPerHour);
                    points.Add(new UnitTrackPoint(m, working ? DispatchStatus.Working : DispatchStatus.OnScene, piece.Site, null, Math.Round(fatigueNow, 1)));
                    break;
                case PieceKind.Work:
                    var seg = UnitDuty.At(piece.Segments, m);
                    if (seg is null)
                    {
                        var last = piece.Segments.LastOrDefault(s => s.To <= m);
                        points.Add(new UnitTrackPoint(m, DispatchStatus.OnScene, aerial ? piece.Site : piece.Place, Water(last?.WaterTo ?? piece.WaterFrom), Math.Round(fatigueNow, 1), Pct(last?.FuelTo ?? piece.FuelFrom)));
                        break;
                    }
                    var status = seg.Phase switch { UnitDuty.Phase.Working => DispatchStatus.Working, UnitDuty.Phase.Resting => DispatchStatus.Resting, _ => DispatchStatus.Refilling };
                    fatigueNow = Math.Min(maxFatigue, UnitDuty.WorkedAt(seg, m) / 60.0 * rules.Crews.FatiguePctPerHour);
                    points.Add(new UnitTrackPoint(m, status, aerial && seg.Phase == UnitDuty.Phase.Working ? Orbit(piece.Site, m) : UnitDuty.PositionAt(seg, m, aerial ? piece.Site : piece.Place),
                        Water(UnitDuty.WaterAt(seg, m)), Math.Round(fatigueNow, 1), Pct(UnitDuty.FuelAt(seg, m))));
                    break;
            }
        }

        foreach (var piece in pieces.Where(x => x.Kind == PieceKind.Work))
        {
            bool started = false;
            foreach (var s in piece.Segments)
            {
                switch (s.Phase)
                {
                    case UnitDuty.Phase.Working when !started: started = true; Add(s.From, "started_working", piece.Place); if (aerial) Add(s.From, "drop", Orbit(piece.Site, (int)Math.Round(s.From)), "largada"); break;
                    case UnitDuty.Phase.Working when aerial: Add(s.From, "drop", Orbit(piece.Site, (int)Math.Round(s.From)), "largada"); break;
                    case UnitDuty.Phase.ToWater:
                        Add(s.From, "water_empty", piece.Place);
                        Add(s.From, "refill_started", piece.Place, $"vai encher a {s.Trip!.PlaceName ?? "ponto de água"} ({(aerial ? "pelo ar" : $"{s.Trip.Minutes:F0} min por estrada")}, {s.Trip.StopMinutes:F0} min a encher)");
                        break;
                    case UnitDuty.Phase.FromWater: Add(s.To, "refill_done", piece.Place); break;
                    case UnitDuty.Phase.Filling when s.Trip is null:
                        Add(s.From, "water_empty", piece.Place);
                        Add(s.From, "refill_started", piece.Place, $"sem ponto de água conhecido {(aerial ? "pelo ar" : "por estrada")}: reabastecimento com o tempo genérico das regras");
                        Add(s.To, "refill_done", piece.Place);
                        break;
                    case UnitDuty.Phase.ToFuel: Add(s.From, "refuel_started", piece.Place, $"vai abastecer a {s.Trip!.PlaceName ?? "posto"} ({s.Trip.Minutes:F0} min por estrada)"); break;
                    case UnitDuty.Phase.FromFuel: Add(s.To, "refuel_done", piece.Place); break;
                    case UnitDuty.Phase.Resting: Add(s.From, "rest_started", piece.Place); Add(s.To, "rest_done", piece.Place); break;
                }
            }
        }
        Add(backAt, "returned", home);
        return new Trace(points, events.OrderBy(e => e.TMin).ThenBy(e => e.Type, StringComparer.Ordinal).ToList(), allSegments, legTimes);
    }

    // ------------------------------------------------------------------------------------------------------------ the units of a plan

    async Task<(FireRun Run, Plan? Plan)> ContextAsync(string simulationId, CancellationToken ct)
    {
        var simulation = await simulations.GetAsync(simulationId, ct) ?? throw new NotFoundException($"Simulação '{simulationId}'");
        if (simulation.Status != SimulationStatus.Succeeded) throw new ConflictException($"A simulação '{simulationId}' está '{EnumText.ToSnake(simulation.Status)}'.", "simulation_not_ready");
        var run = await runs.GetAsync(simulationId, ct) ?? throw new NotFoundException($"Resultado da simulação '{simulationId}'");
        var plan = simulation.PlanId is { } planId ? await plans.GetAsync(planId, ct) : null;
        return (run, plan);
    }

    Task<List<Demand>> DemandsAsync(string simulationId, Plan plan, FireRun run, CancellationToken ct)
    {
        string key = $"{simulationId}|{plan.Id}|{plan.UpdatedAt.UtcTicks}";
        if (_demands.Count > MaxRememberedPlans) _demands.Clear();
        var lazy = _demands.GetOrAdd(key, _ => new Lazy<Task<List<Demand>>>(() => ComputeDemandsAsync(plan, run, CancellationToken.None)));
        if (lazy.Value.IsFaulted || lazy.Value.IsCanceled) _demands.TryRemove(key, out _);
        return lazy.Value.WaitAsync(ct);
    }

    sealed record Job(PlanAction Action, ResourceAssignment Assignment, Target Target, LatLon Site, double Start, double Duration);

    async Task<List<Demand>> ComputeDemandsAsync(Plan plan, FireRun run, CancellationToken ct)
    {
        var rules = settings.Rules;
        var jobs = new Dictionary<string, List<Job>>();
        var order = new List<string>();
        foreach (var action in plan.Actions)
        {
            if (action.Resources is not { Count: > 0 }) continue;
            var target = PlanService.TargetOf(action);
            if (target.IsEmpty || await targets.PositionAsync(target, plan.LocationId, ct) is not { } site) continue;
            var start = Math.Max(0, PlanTiming.StartMinutes(plan, action));
            var duration = Math.Max(1, action.ExpectedDurationMinutes ?? settings.Limits.DefaultActionWindowMinutes);
            foreach (var assignment in action.Resources.Where(r => r.ResourceType != ResourceType.Equipment))
            {
                if (!jobs.TryGetValue(assignment.ResourceId, out var list)) { jobs[assignment.ResourceId] = list = new(); order.Add(assignment.ResourceId); }
                list.Add(new Job(action, assignment, target, site, start, duration));
            }
        }

        var demands = new List<Demand>();
        foreach (var unitId in order)
        {
            var mine = jobs[unitId].OrderBy(j => j.Start).ToList(); // as ações do meio, pela ordem em que o plano as manda começar
            var first = mine[0];
            var vehicle = first.Assignment.ResourceType == ResourceType.Vehicle ? await vehicles.GetAsync(unitId, ct) : null;
            var pool = first.Assignment.ResourceType == ResourceType.PersonnelPool ? await pools.GetAsync(unitId, ct) : null;
            if (vehicle is null && pool is null) continue;
            bool aerial = vehicle is not null && ArrivalEstimator.IsAerial(vehicle.Type), ground = vehicle is not null && !aerial;

            LatLon? origin = vehicle is not null ? await arrival.OriginAsync(vehicle, first.Assignment.FromStationId, ct)
                : pool?.StationId is { } stationId ? (await stations.GetAsync(stationId, ct))?.Position : null;
            var legs = new List<Leg>();
            LatLon here = origin ?? first.Site;
            for (int i = 0; i < mine.Count; i++)
            {
                var job = mine[i];
                LineString? route = job.Assignment.Route;
                double eta = job.Assignment.EtaMinutes ?? 0;
                if (ground)
                {
                    if (i == 0 && (route is null || eta <= 0))
                    {
                        // a estimativa só serve para o que o plano não trouxe (percurso e ETA gravados ao publicar)
                        var estimate = await arrival.ForActionAsync(plan, job.Action, vehicle!, job.Assignment, ct);
                        if (eta <= 0 && estimate?.Minutes is { } minutes) eta = minutes;
                        route ??= estimate?.Route;
                    }
                    else if (i > 0 && (route is not { NumPoints: > 1 } || Far(StartOf(route), here)))
                    {
                        // a ação seguinte parte de onde a viatura acabou a anterior, não do quartel
                        var estimate = await arrival.EstimateAsync(vehicle!, here, job.Site, plan.LocationId, PlanTiming.StartAt(plan, job.Action), ct);
                        route = estimate.Route;
                        eta = estimate.Minutes ?? eta;
                    }
                    if (i > 0 && route is not { NumPoints: > 1 } && !Far(job.Site, here))
                    {
                        // a unit that stays where it is (holding after its job, ready for the next one) has nowhere to drive: a zero-length leg, not "no road to the target"
                        route = Line(here, job.Site);
                        eta = 0;
                    }
                }
                else if (route is not { NumPoints: > 1 }) route = null; // pelo ar ou a pé: em linha reta (Build)

                UnitDuty.Trip? water = null, fuel = null;
                if (ground && route is { NumPoints: > 1 })
                {
                    var park = EndOf(route);
                    var (capacity, lpm) = WaterOf(vehicle, rules);
                    if (capacity > 0 && lpm > 0) water = await TripAsync("water", plan.LocationId, vehicle!, park, capacity, ct, run, job.Start + Math.Max(0, eta), job.Start + Math.Max(0, eta) + job.Duration);
                    fuel = await TripAsync("fuel", plan.LocationId, vehicle!, park, 0, ct);
                    here = park;
                }
                else if (aerial)
                {
                    here = job.Site;
                    var (capacity, _) = WaterOf(vehicle, rules);
                    if (capacity > 0) water = await TripAsync("water", plan.LocationId, vehicle!, here, capacity, ct);
                }
                else if (!ground) here = job.Site;
                legs.Add(new Leg(job.Start, Math.Max(0, eta), job.Duration, route, job.Site, water, fuel, job.Action.Title));
            }

            var home = origin ?? here;
            var (back, backEta) = await WayHomeAsync(plan.LocationId, vehicle, legs, here, home, ct);
            demands.Add(MakeDemand(unitId, first.Assignment.ResourceType, vehicle, pool, vehicle?.OrganizationId ?? pool?.OrganizationId ?? first.Action.OrganizationId, first.Assignment.Responsibility,
                first.Assignment.Personnel ?? vehicle?.CrewCapacity ?? 1, first.Target, legs, home, back, backEta, run));
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
            var estimate = vehicle is not null && origin is not null ? await arrival.EstimateAsync(vehicle, origin, site, plan.LocationId, dispatch.StartAt, ct) : null;
            bool ground = vehicle is not null && !ArrivalEstimator.IsAerial(vehicle.Type);
            var route = dispatch.Route ?? estimate?.Route;
            UnitDuty.Trip? water = null, fuel = null;
            if (ground && route is { NumPoints: > 1 })
            {
                var (capacity, lpm) = WaterOf(vehicle, settings.Rules);
                if (capacity > 0 && lpm > 0) water = await TripAsync("water", plan.LocationId, vehicle!, EndOf(route), capacity, ct, run, start + (estimate?.Minutes ?? dispatch.EtaMinutes ?? 0), start + (estimate?.Minutes ?? dispatch.EtaMinutes ?? 0) + duration);
                fuel = await TripAsync("fuel", plan.LocationId, vehicle!, EndOf(route), 0, ct);
            }
            else if (vehicle is not null && ArrivalEstimator.IsAerial(vehicle.Type))
            {
                var (capacity, _) = WaterOf(vehicle, settings.Rules);
                if (capacity > 0) water = await TripAsync("water", plan.LocationId, vehicle!, site, capacity, ct);
            }
            double eta = Math.Max(0, dispatch.EtaMinutes ?? estimate?.Minutes ?? 0);
            var legs = new List<Leg> { new(start, eta, duration, route is { NumPoints: > 1 } ? route : null, site, water, fuel, action?.Title) };
            var home = origin ?? site;
            var here = ground && route is { NumPoints: > 1 } ? EndOf(route) : site;
            var (back, backEta) = await WayHomeAsync(plan.LocationId, vehicle, legs, here, home, ct);
            demands.Add(MakeDemand(dispatch.ResourceId, dispatch.ResourceType, vehicle, pool, vehicle?.OrganizationId ?? pool?.OrganizationId ?? dispatch.OrganizationId, dispatch.Responsibility,
                dispatch.Personnel > 0 ? dispatch.Personnel : vehicle?.CrewCapacity ?? 1, dispatch.Target, legs, home, back, backEta, run));
        }
        return demands;
    }

    static bool Far(LatLon a, LatLon b) => RoadGeometry.DistanceM(a.Lat, a.Lon, b.Lat, b.Lon) > SameSpotM;

    /// <summary>
    /// Por onde volta ao posto no fim e quanto demora: pelo caminho por onde veio se só fez uma ação e partiu do posto; senão, uma rota por estrada de onde acabou (pelo ar ou a pé,
    /// em linha reta, ao mesmo ritmo da ida).
    /// </summary>
    async Task<(LineString? Route, double Eta)> WayHomeAsync(string locationId, Vehicle? vehicle, IReadOnlyList<Leg> legs, LatLon here, LatLon home, CancellationToken ct)
    {
        var first = legs[0];
        bool ground = vehicle is not null && !ArrivalEstimator.IsAerial(vehicle.Type);
        if (!ground)
        {
            double outM = RoadGeometry.DistanceM(home.Lat, home.Lon, first.Site.Lat, first.Site.Lon), backM = RoadGeometry.DistanceM(here.Lat, here.Lon, home.Lat, home.Lon);
            return (Line(here, home), outM > 1 ? first.Eta * backM / outM : first.Eta);
        }
        var routed = legs.Where(l => l.Route is { NumPoints: > 1 }).ToList();
        if (routed.Count == 0) return (null, first.Eta);
        if (routed.Count == 1 && !Far(StartOf(routed[0].Route!), home)) return ((LineString)routed[0].Route!.Reverse(), routed[0].Eta);
        var estimate = await arrival.EstimateAsync(vehicle, here, home, locationId, null, ct);
        return estimate.Route is { NumPoints: > 1 } r && estimate.Minutes is { } minutes ? (r, minutes) : ((LineString)routed[^1].Route!.Reverse(), routed[^1].Eta);
    }

    Demand MakeDemand(string unitId, ResourceType type, Vehicle? vehicle, PersonnelPool? pool, string organizationId, Responsibility? responsibility, int personnel, Target target,
        IReadOnlyList<Leg> legs, LatLon home, LineString? back, double backEta, FireRun run)
    {
        var rules = settings.Rules;
        var trace = Build(run.DurationMinutes, legs, home, back, backEta, vehicle, rules);
        var (waterCap, waterLpm) = WaterOf(vehicle, rules);
        return new Demand(unitId, type, vehicle?.Callsign ?? pool?.Role.ToString(), organizationId, responsibility, personnel, target, vehicle, legs[0].Eta, waterCap, waterLpm,
            FuelOf(vehicle, rules).CapacityL, vehicle is not null && ArrivalEstimator.IsAerial(vehicle.Type), trace);
    }

    /// <summary>
    /// A ida a um ponto de água (`kind = water`, das fontes das regras, acessível a autotanques) ou a um posto de abastecimento (`fuel`, das fontes de combustível) e o tempo lá:
    /// o mais rápido de alcançar por estrada, com o perfil da própria viatura, entre os mais perto em linha reta, e o percurso que ela faz. Nula se nenhum se alcança.
    /// </summary>
    Task<UnitDuty.Trip?> TripAsync(string kind, string locationId, Vehicle v, LatLon from, double waterCapacityL, CancellationToken ct, FireRun? fire = null, double when = 0, double until = 0)
    {
        // com o fogo da simulação: a primeira ida à água faz-se por volta de `when`, por isso um ponto de água que arde nessa altura não serve (a chave leva a simulação e o período)
        string key = $"{kind}|{locationId}|{from.Lat:F5},{from.Lon:F5}|{v.Type}|{v.OffRoad}|{v.HeightM}|{v.WidthM}|{v.WeightT}|{v.MaxSlopePercent}|{waterCapacityL}|{fire?.SimulationId}|{(int)(when / 15)}|{(int)(until / 15)}";
        if (_trips.Count > MaxRememberedTrips) _trips.Clear();
        var lazy = _trips.GetOrAdd(key, _ => new Lazy<Task<UnitDuty.Trip?>>(() => FindTripAsync(kind, locationId, v, from, waterCapacityL, CancellationToken.None, fire, when, until)));
        return lazy.Value.WaitAsync(ct);
    }

    /// <summary>O fogo arde no local em algum momento entre `from` e `until` (mais a viagem): já a arder em `from` ou a chegar até `until`. Depois de ter ardido, o ponto serve.</summary>
    static bool FireNear(FireRun fire, LatLon at, double from, double until)
    {
        int cell = fire.Spec.CellAt(at.Lat, at.Lon);
        if (cell < 0 || cell >= fire.Ignition.Length) return false;
        int m = fire.Ignition[cell];
        return m >= 0 && m <= Math.Max(from, until) + 15 && from < m + 20;
    }

    const int TripCandidates = 8;

    async Task<UnitDuty.Trip?> FindTripAsync(string kind, string locationId, Vehicle v, LatLon from, double waterCapacityL, CancellationToken ct, FireRun? fire = null, double when = 0, double until = 0)
    {
        try
        {
            var rules = settings.Rules;
            bool aerial = ArrivalEstimator.IsAerial(v.Type);
            List<(string Id, string Name, LatLon Position, double StopMinutes)> places;
            if (kind == "water")
            {
                var sources = rules.Water.Refill.Sources.ToHashSet(StringComparer.Ordinal);
                var allWater = await map.WaterPointsAsync(locationId, ct);
                // um meio aéreo enche numa massa de água onde pode mergulhar o balde (nunca numa boca de incêndio), a mais perto de onde trabalha e dentro do alcance das regras;
                // sem nenhuma, volta ao que servir de apoio (o que as regras listam)
                double reachM = rules.Aerial.Limits.MaxDistanceToWaterKm * 1000.0;
                var dippable = aerial ? allWater.Where(w => w.Available && w.HelicopterAccessible && RoadGeometry.DistanceM(from.Lat, from.Lon, w.Position.Lat, w.Position.Lon) <= reachM).ToList() : new();
                places = (aerial && dippable.Count > 0 ? dippable : allWater)
                    .Where(w => w.Available && (aerial ? (w.HelicopterAccessible || sources.Contains(w.Kind)) : (w.TruckAccessible && sources.Contains(w.Kind))))
                    .Select(w => (w.Id, w.Name, w.Position, aerial ? (v.Aerial?.LoadMinutes ?? 1.0) : rules.Water.Refill.SetupMinutes + waterCapacityL / (w.FlowLpm is > 0 ? w.FlowLpm.Value : w.Kind == "hydrant" ? rules.Water.Refill.HydrantFlowLpm : rules.Water.Refill.DefaultFlowLpm)))
                    .ToList();
            }
            else
            {
                var sources = rules.Fuel.Sources.ToHashSet(StringComparer.Ordinal);
                places = (await map.FacilitiesAsync(locationId, ct)).Where(f => sources.Contains(f.Kind)).Select(f => (f.Id, f.Name, f.Position, rules.Fuel.RefuelMinutes)).ToList();
            }
            if (fire is not null && !aerial && kind == "water")
            {
                var clear = places.Where(p => !FireNear(fire, p.Position, when, until)).ToList(); // não vai encher a um ponto onde o fogo está nessa altura (se houver outro)
                if (clear.Count > 0) places = clear;
            }
            if (places.Count == 0) return null;
            if (aerial && kind == "water")
            {
                var nearestAerial = places.OrderBy(p => RoadGeometry.DistanceM(from.Lat, from.Lon, p.Position.Lat, p.Position.Lon)).First();
                double distM = RoadGeometry.DistanceM(from.Lat, from.Lon, nearestAerial.Position.Lat, nearestAerial.Position.Lon);
                double speedKmh = v.CruiseSpeedKmh ?? v.Aerial?.CruiseSpeedKmh ?? rules.Aerial.Helicopter.CruiseSpeedKmh;
                double minutes = Math.Max(0.5, distM / (speedKmh * 1000.0 / 60.0));
                var airPath = RoutePath.Of(Line(from, nearestAerial.Position));
                return new UnitDuty.Trip(airPath, minutes, nearestAerial.StopMinutes, nearestAerial.Id, nearestAerial.Name, nearestAerial.Position);
            }
            var nearest = places.OrderBy(p => RoadGeometry.DistanceM(from.Lat, from.Lon, p.Position.Lat, p.Position.Lon)).Take(TripCandidates).ToList();
            if (nearest.Count == 0) return null;
            var profile = new VehicleProfile(v.Type, v.HeightM, v.WidthM, v.WeightT, v.OffRoad, v.CruiseSpeedKmh, v.MaxSlopePercent);
            var drive = await routing.DriveMinutesAsync(locationId, from, nearest.Select(p => p.Position).ToList(), profile, ct);
            foreach (var (place, _) in nearest.Zip(drive).Where(x => x.Second is not null).OrderBy(x => x.Second))
            {
                var estimate = await arrival.EstimateAsync(v, from, place.Position, locationId, null, ct);
                if (estimate.Minutes is not { } minutes || estimate.Route is not { NumPoints: > 1 } path) continue;
                return new UnitDuty.Trip(RoutePath.Of(path), Math.Max(1, minutes), Math.Max(1, place.StopMinutes), place.Id, place.Name, place.Position);
            }
            return null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            return null; // sem viagem conhecida: a viatura reabastece com o tempo genérico das regras
        }
    }

    UnitState StateOf(Demand d, int minute, FireRun run)
    {
        var points = d.Trace.Points;
        int at = Math.Clamp(minute, 0, points.Count - 1);
        var point = points[at];
        var segment = UnitDuty.At(d.Trace.Segments, at);
        int worked = 0;
        for (int i = 0; i <= at; i++) if (points[i].Status == DispatchStatus.Working) worked++;

        WaterStatus? water = null;
        if (d.WaterCapacityL > 0 && d.Vehicle is not null)
        {
            bool goingToWater = segment is { Phase: UnitDuty.Phase.ToWater or UnitDuty.Phase.Filling, Trip: not null };
            var emptyAt = d.Trace.Segments.FirstOrDefault(s => s.From >= at && (s.Phase == UnitDuty.Phase.ToWater || (s.Phase == UnitDuty.Phase.Filling && s.Trip is null)))?.From;
            water = new WaterStatus(point.WaterLevelL ?? d.WaterCapacityL, d.WaterCapacityL, d.WaterLpm, goingToWater ? segment!.Trip!.PlaceId : null,
                segment is { Phase: UnitDuty.Phase.ToWater } s0 ? Math.Round(s0.To - at, 1) : null, emptyAt is { } e ? (int)Math.Round(e) : null);
        }
        var fuel = d.FuelCapacityL > 0 && point.FuelPct is { } pct
            ? new FuelStatus(pct, d.FuelCapacityL, segment is { Phase: UnitDuty.Phase.ToFuel or UnitDuty.Phase.Fueling } s1 ? s1.Trip?.PlaceId : null)
            : null;
        var crew = d.Personnel > 0
            ? new CrewStatus(worked, point.FatiguePct ?? 0, run.Start.AddHours(settings.Rules.Crews.ShiftLengthHours), run.Start.AddMinutes(settings.Rules.Crews.MaxContinuousWorkMinutes))
            : null;
        AerialStatus? aerial = null;
        if (d.Aerial)
        {
            double cycle = (d.Vehicle?.Aerial?.LoadMinutes ?? 0) + (d.Vehicle?.Aerial?.DropMinutes ?? 0);
            int drops = (int)(worked / Math.Max(1, cycle));
            aerial = new AerialStatus(drops, drops * (d.Vehicle?.Aerial?.BucketCapacityL ?? 0), cycle, null);
        }
        double? eta = d.Eta;
        if (point.Status == DispatchStatus.EnRoute && d.Trace.Legs.FirstOrDefault(l => l.Depart <= at && at < l.Arrive) is { Arrive: > 0 } leg) eta = Math.Max(0, leg.Arrive - at);
        return new UnitState(d.UnitId, point.Status, d.ResourceType, d.Callsign, d.OrganizationId, DispatchId: null, d.Responsibility, point.Position, d.Target,
            eta, d.Personnel, water, crew, aerial, fuel);
    }
}
