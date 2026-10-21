using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Models.Operations;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// O que cada meio de um plano faz, minuto a minuto: espera no posto, parte à hora da ação, segue a rota por estrada que o servidor calculou (`etaMinutes` é o tempo que demora), chega, trabalha por janelas com a água
/// e o cansaço das `Rules` (`CrewWorkSchedule`: esvazia o depósito, vai reabastecer, cansa-se, descansa), e no fim regressa ao posto pelo mesmo caminho.
/// É uma função do plano e dos recursos que o plano usa: dois pedidos iguais dão a mesma resposta. Nada aqui mexe no fogo: os efeitos dos meios no fogo continuam a ser calculados pelo motor.
/// </summary>
public static class OperationSimulator
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);

    /// <summary>Os meios de um plano: `sites` diz onde cada ação atua (por id da ação; uma ação sem sítio não tem meios a mover) e `stations` onde fica cada posto (por id).</summary>
    public static IReadOnlyList<UnitTimeline> Simulate(Plan plan, DateTimeOffset scenarioStart, int durationMinutes, IReadOnlyDictionary<string, Vehicle> vehicles, IReadOnlyDictionary<string, PersonnelPool> pools,
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
}
