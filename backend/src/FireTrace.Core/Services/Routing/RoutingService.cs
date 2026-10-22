using System.Runtime.CompilerServices;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Models.Routing;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Map;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Routing;

/// <summary>Rotas e tempos de acesso que respeitam os cortes de estrada, o fogo previsto numa simulação e o tipo de viatura.</summary>
public sealed class RoutingService(IMapReader map, IDocumentStore<RoadClosure> closures, IDocumentStore<Station> stations, IDocumentStore<Organization> organizations, IFireRunRepository runs, RoadCutsCache cutsCache, RoadSpeeds speeds, RoutingSettings routing, MapQueries queries, TimeProvider clock)
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
    readonly ConditionalWeakTable<RoadNetwork, RoadGraph> _graphs = new();

    /// <summary>O grafo (com declives) é caro de construir e só depende da rede: constrói-se uma vez por rede.</summary>
    async Task<RoadGraph> GraphAsync(RoadNetwork net, string locationId, CancellationToken ct)
    {
        if (_graphs.TryGetValue(net, out var cached)) return cached;
        var built = RoadGraph.For(net).WithSlopes(RoadSlopes.Of(net, await map.GetTerrainAsync(locationId, ct)));
        return _graphs.GetValue(net, _ => built);
    }

    public async Task<RoutePlan> RouteAsync(RouteRequest req, CancellationToken ct = default) => (await RouteWithAccessAsync(req, ct)).Plan;

    /// <summary>
    /// A rota por estrada e o troço a pé que sobra nas pontas. Uma viatura só anda na rede viária: se a origem ou o destino estão a mais de `MaxSnapM` da estrada mais próxima
    /// não há rota (`no_road_access`); até esse limite a rota termina na estrada e a distância até ao ponto faz-se a pé (`WalkKmh`).
    /// </summary>
    public async Task<RouteAccess> RouteWithAccessAsync(RouteRequest req, CancellationToken ct = default)
    {
        var loc = map.Locations.Get(req.LocationId);
        var net = await map.GetRoadsAsync(req.LocationId, ct);
        var graph = await GraphAsync(net, req.LocationId, ct);
        var from = req.From ?? (req.FromStationId is { } sid ? (await stations.GetAsync(sid, ct) ?? throw new NotFoundException($"Posto '{sid}'")).Position
            : throw new ValidationException("Indique `from` ou `fromStationId`.", "/from"));
        Anchor A(string k, LatLon p) { var (x, y) = net.Spec.ToCell(p.Lat, p.Lon); return new Anchor(k, x, y); }
        var index = queries.IndexOf(net);
        var fromAccess = index.Nearest(from.Lat, from.Lon, routing.MaxSnapM);
        var toAccess = index.Nearest(req.To.Lat, req.To.Lon, routing.MaxSnapM);
        if (fromAccess is null || toAccess is null)
        {
            var issues = new List<ValidationIssue>();
            if (fromAccess is null) issues.Add(new("warning", "no_road_access", $"A origem está a mais de {routing.MaxSnapM:F0} m de qualquer estrada: uma viatura não chega lá.", "/from"));
            if (toAccess is null) issues.Add(new("warning", "no_road_access", $"O destino está a mais de {routing.MaxSnapM:F0} m de qualquer estrada: uma viatura não chega lá.", "/to"));
            return new RouteAccess(new RoutePlan(false, Warnings: issues), 0, 0);
        }
        var avoid = req.Avoid ?? new AvoidOptions();
        var at = req.At;
        var closed = avoid.ActiveClosures ? await ClosedEdges(req.LocationId, at, req.EmergencyVehicle, ct) : new Dictionary<int, string>();
        var run = avoid.PredictedFire && req.SimulationId is { } simId ? await runs.GetAsync(simId, ct) ?? throw new NotFoundException($"Resultados da simulação '{simId}'") : null;
        RoadCuts? cuts = run is null ? null : (await cutsCache.ForPercentileAsync(run, avoid.Percentile, avoid.BufferM ?? speeds.Movement.FireClearanceM, ct)).Cuts;
        double startMin = run is not null && at is { } t0 ? (t0 - run.Start).TotalMinutes : 0;
        var profile = (req.Vehicle ?? new VehicleProfile()).ToTravel(speeds, routing, req.EmergencyVehicle);

        var blocked = new HashSet<int>(); var reasons = new List<BlockedRoad>();
        for (int attempt = 0; attempt < routing.MaxReroutes; attempt++)
        {
            var path = graph.Route(A("from", from), A("to", req.To), profile, e => blocked.Contains(e) || closed.ContainsKey(net.Edges[e].Id));
            if (path is null) return new RouteAccess(new RoutePlan(false, BlockedBy: reasons, Warnings: new List<ValidationIssue> { new("warning", "no_route", "Não há caminho entre os dois pontos com estas restrições.") }), 0, 0);
            var fresh = FireConflicts(net, graph, path, cuts, startMin, profile).Where(c => blocked.Add(c.Edge)).ToList();
            if (fresh.Count == 0)
            {
                reasons.AddRange(closed.Where(c => path.EdgeIds.Contains(c.Key)).Select(c => new BlockedRoad(MapIds.Road(c.Key), "closure", c.Value)));
                var geometry = Gf.CreateLineString(Enumerable.Range(0, path.Points.Length / 2).Select(i => { var (lat, lon) = net.Spec.ToLatLon(path.Points[2 * i], path.Points[2 * i + 1]); return new Coordinate(Math.Round(lon, 6), Math.Round(lat, 6)); }).ToArray());
                return new RouteAccess(new RoutePlan(true, path.DistanceM, path.Minutes, geometry, path.EdgeIds.Select(MapIds.Road).ToList(), reasons, Warnings(loc, from, req.To, net)), Math.Round(fromAccess.Value.DistanceM), Math.Round(toAccess.Value.DistanceM));
            }
            reasons.AddRange(fresh.Select(c => new BlockedRoad(MapIds.Road(net.Edges[c.Edge].Id), "predicted_fire", AtMinute: c.AtMinute)));
        }
        return new RouteAccess(new RoutePlan(false, BlockedBy: reasons, Warnings: new List<ValidationIssue> { new("warning", "no_safe_route", "Todos os caminhos passam por troços que o fogo previsto atinge.") }), 0, 0);
    }

    /// <summary>Troços do percurso que o fogo previsto corta enquanto a viatura os atravessa.</summary>
    static IEnumerable<(int Edge, double AtMinute)> FireConflicts(RoadNetwork net, RoadGraph graph, PathResult path, RoadCuts? cuts, double startMin, TravelProfile profile)
    {
        if (cuts is null) yield break;
        double t = startMin;
        var index = net.Edges.Select((edge, i) => (edge.Id, i)).ToDictionary(x => x.Id, x => x.i);
        foreach (var id in path.EdgeIds)
        {
            int e = index[id];
            double minutes = profile.Minutes(net.Edges[e], net.Spec.CellM, graph.SlopeOf(e)) ?? 0;
            if (cuts.IsCutDuring(e, t, t + minutes)) yield return (e, Math.Round(t, 1));
            t += minutes;
        }
    }

    static IReadOnlyList<ValidationIssue> Warnings(LocationDefinition loc, LatLon from, LatLon to, RoadNetwork net)
    {
        var w = new List<ValidationIssue>();
        foreach (var (name, p) in new[] { ("origem", from), ("destino", to) })
            if (net.Spec.CellAt(p.Lat, p.Lon) < 0) w.Add(new("warning", "outside_location", $"A {name} está fora do local '{loc.Id}'."));
        return w;
    }

    /// <summary>Troços (índice → id do corte) cortados num instante, ignorando os que isentam viaturas de emergência quando é o caso.</summary>
    async Task<Dictionary<int, string>> ClosedEdges(string locationId, DateTimeOffset? at, bool emergency, CancellationToken ct)
    {
        var now = at ?? clock.GetUtcNow();
        var result = new Dictionary<int, string>();
        foreach (var c in (await closures.ListAsync(ct)).Where(c => c.LocationId == locationId && c.Status == ClosureStatus.Active && c.Start <= now && (c.End is null || c.End > now)))
        {
            if (emergency && c.Exemptions?.Contains(ClosureExemption.EmergencyVehicles) == true) continue;
            foreach (var id in c.RoadIds ?? new()) if (MapIds.RoadNumber(id) is { } n) result[n] = c.Id;
        }
        return result;
    }

    /// <summary>Minutos por estrada (viatura de emergência, com cortes ativos) de um ponto até cada destino; nada se não houver caminho.</summary>
    public async Task<IReadOnlyList<double?>> DriveMinutesAsync(string locationId, LatLon from, IReadOnlyList<LatLon> destinations, CancellationToken ct = default)
    {
        var net = await map.GetRoadsAsync(locationId, ct);
        Anchor A(LatLon p) { var (x, y) = net.Spec.ToCell(p.Lat, p.Lon); return new Anchor("", x, y); }
        var closed = await ClosedEdges(locationId, null, true, ct);
        return RoadGraph.For(net).AccessTimes(new[] { A(from) }, destinations.Select(A).ToList(), speeds.Profile(), e => closed.ContainsKey(net.Edges[e].Id));
    }

    /// <summary>
    /// Como acima, para uma viatura concreta (um VFCI anda em caminhos florestais que o perfil genérico não usa; um pesado não sobe onde um ligeiro sobe):
    /// de onde ela está, sobretudo quando parou no fim de um caminho, só os destinos que ela própria alcança.
    /// </summary>
    public async Task<IReadOnlyList<double?>> DriveMinutesAsync(string locationId, LatLon from, IReadOnlyList<LatLon> destinations, VehicleProfile vehicle, CancellationToken ct = default)
    {
        var net = await map.GetRoadsAsync(locationId, ct);
        var graph = await GraphAsync(net, locationId, ct);
        Anchor A(LatLon p) { var (x, y) = net.Spec.ToCell(p.Lat, p.Lon); return new Anchor("", x, y); }
        var closed = await ClosedEdges(locationId, null, true, ct);
        return graph.AccessTimes(new[] { A(from) }, destinations.Select(A).ToList(), vehicle.ToTravel(speeds, routing, emergency: true), e => closed.ContainsKey(net.Edges[e].Id));
    }

    public async Task<AccessMatrix> AccessAsync(AccessRequest req, CancellationToken ct = default)
    {
        var net = await map.GetRoadsAsync(req.LocationId, ct);
        var graph = RoadGraph.For(net);
        Anchor A(string k, LatLon p) { var (x, y) = net.Spec.ToCell(p.Lat, p.Lon); return new Anchor(k, x, y); }

        var origins = new List<(string Id, string? Type, Anchor Anchor)>();
        foreach (var o in req.Origins ?? new())
        {
            if (o.StationId is { } sid && await stations.GetAsync(sid, ct) is { } st) origins.Add((st.Id, null, A(st.Id, st.Position)));
            else if (o.Position is { } pos) origins.Add(($"{pos.Lat:F4},{pos.Lon:F4}", null, A("point", pos)));
        }
        if (req.OriginTypes is { Count: > 0 } types)
        {
            var orgs = (await organizations.ListAsync(ct)).Where(o => types.Contains(o.Type)).ToDictionary(o => o.Id, o => o.Type);
            foreach (var st in (await stations.ListAsync(ct)).Where(s => s.LocationId == req.LocationId && orgs.ContainsKey(s.OrganizationId)))
                origins.Add((st.Id, EnumText.ToSnake(orgs[st.OrganizationId]), A(st.Id, st.Position)));
        }
        if (origins.Count == 0) throw new ValidationException("Indique `origins` ou `originTypes` com postos registados.", "/origins");

        var places = (await map.GetPlacesAsync(req.LocationId, ct)).Where(p => req.DestinationPlaceIds is not { Count: > 0 } ids || ids.Contains(MapIds.Place(p.Id))).ToList();
        Func<int, bool>? blocked = null;
        var closed = await ClosedEdges(req.LocationId, req.At, true, ct);
        RoadCuts? cuts = null; double tMin = 0;
        if (req.SimulationId is { } simId && await runs.GetAsync(simId, ct) is { } run)
        {
            cuts = (await cutsCache.ForPercentileAsync(run, req.Percentile, ct: ct)).Cuts;
            tMin = req.At is { } at ? (at - run.Start).TotalMinutes : 0;
        }
        blocked = e => closed.ContainsKey(net.Edges[e].Id) || (cuts?.IsCut(e, (int)tMin) ?? false);

        var targets = places.Select(p => A(p.Name, new LatLon(p.Lat, p.Lon))).ToList();
        var perOrigin = origins.Select(o => (o, Times: graph.AccessTimes(new[] { o.Anchor }, targets, speeds.Profile(), blocked))).ToList();
        var entries = places.Select((p, i) =>
        {
            var by = perOrigin.Select(x => new OriginAccess(x.o.Id, x.Times[i], x.Times[i] is not null)).ToList();
            var best = perOrigin.Where(x => x.Times[i] is not null).OrderBy(x => x.Times[i]).Select(x => new BestOrigin(x.o.Id, x.o.Type, x.Times[i])).FirstOrDefault() ?? new BestOrigin(null, null, null);
            return new AccessEntry(MapIds.Place(p.Id), p.Name, best, by, best.Minutes is null);
        }).ToList();
        return new AccessMatrix(req.LocationId, req.At, entries);
    }
}
