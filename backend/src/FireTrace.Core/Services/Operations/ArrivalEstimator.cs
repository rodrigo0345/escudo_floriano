using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Routing;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Map;
using FireTrace.Core.Services.Routing;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>Quanto demora um meio a chegar a um ponto e por onde: o único sítio que responde a isto (despachos, validação de planos e efeito dos planos no fogo).</summary>
public sealed class ArrivalEstimator(RoutingService routing, IMapReader map, IDocumentStore<Station> stations, MapQueries queries, RoutingSettings settings, TargetResolver targets)
{
    public sealed record Arrival(double? Minutes, LineString? Route, ValidationIssue? Problem);

    public static bool IsAerial(VehicleType? type) => type is VehicleType.Helicopter or VehicleType.Airtanker or VehicleType.Drone;

    /// <summary>De onde sai a viatura: do posto indicado, senão de onde está agora, senão do seu posto.</summary>
    public async Task<LatLon?> OriginAsync(Vehicle v, string? fromStationId, CancellationToken ct)
    {
        if (fromStationId is { } sid && await stations.GetAsync(sid, ct) is { } chosen) return chosen.Position;
        if (v.State.Position is { } here) return here;
        return v.StationId is { } home ? (await stations.GetAsync(home, ct))?.Position : null;
    }

    /// <summary>
    /// O local que contém o ponto: o indicado, se o cobre, senão o primeiro que o cobre. O indicado é muitas vezes o do posto do meio, e um posto do detalhe da Penha
    /// manda viaturas para todo o concelho: fora do mapa do detalhe não há estradas, e o alvo parecia "a mais de 500 m de qualquer estrada".
    /// </summary>
    public string? LocationOf(LatLon p, string? locationId = null) => LocationOf(new[] { p }, locationId);

    /// <summary>O local cujo mapa tem todos os pontos (a partida e o alvo de uma viagem), com preferência pelo indicado; senão o que tem o último (o alvo).</summary>
    string? LocationOf(IReadOnlyList<LatLon> points, string? locationId)
    {
        bool Covers(LocationDefinition l, LatLon p) => l.Spec.CellAt(p.Lat, p.Lon) >= 0;
        var given = locationId is null ? null : map.Locations.Find(locationId);
        if (locationId is not null && given is null) return locationId; // a location this server does not know: the caller's stands, as before
        if (given is not null && points.All(p => Covers(given, p))) return given.Id;
        return map.Locations.All.FirstOrDefault(l => points.All(p => Covers(l, p)))?.Id
            ?? (given is not null && Covers(given, points[^1]) ? given.Id : map.Locations.All.FirstOrDefault(l => Covers(l, points[^1]))?.Id);
    }

    /// <summary>
    /// Minutos até ao ponto: por estrada (cortes ativos, tipo de viatura) mais o que falta a pé até ao ponto, ou em linha reta se for um meio aéreo.
    /// Sem estrada que lá chegue o erro é `target_unreachable`: não há tempo de chegada, nunca um tempo "a atravessar o mato".
    /// </summary>
    public async Task<Arrival> EstimateAsync(Vehicle? v, LatLon from, LatLon to, string? locationId, DateTimeOffset? at, CancellationToken ct)
    {
        if (v is not null && IsAerial(v.Type))
        {
            double kmh = v.CruiseSpeedKmh ?? v.Aerial?.CruiseSpeedKmh ?? settings.AerialDefaultKmh;
            return new Arrival(Math.Round(RoadGeometry.DistanceM(from.Lat, from.Lon, to.Lat, to.Lon) / (kmh * 1000 / 60), 1), null, null);
        }

        var location = LocationOf(new[] { from, to }, locationId); // a map with both ends: the trip starts at the station and ends at the target
        if (location is null) return new Arrival(null, null, new("warning", "outside_locations", "O alvo está fora dos locais conhecidos; sem chegada estimada.", "/target"));
        var access = await routing.RouteWithAccessAsync(new RouteRequest(location, to, from, At: at,
            Vehicle: new VehicleProfile(v?.Type, v?.HeightM, v?.WidthM, v?.WeightT, v?.OffRoad, v?.CruiseSpeedKmh, v?.MaxSlopePercent)), ct);
        if (access.TotalMinutes(settings.WalkKmh) is not { } minutes)
        {
            string why = access.Plan.Warnings is { Count: > 0 } w ? " " + string.Join(" ", w.Select(x => x.Message)) : "";
            return new Arrival(null, null, new("error", "target_unreachable", "Não há caminho por estrada até ao alvo com os cortes e restrições atuais." + why, "/target"));
        }
        return new Arrival(minutes, access.Plan.Geometry, null);
    }

    /// <summary>A chegada de uma viatura ao sítio onde a ação atua (do posto do recurso, à hora do gatilho); nada se a ação não tem sítio ou a viatura não tem posição de partida.</summary>
    public async Task<Arrival?> ForActionAsync(Plan plan, PlanAction action, Vehicle v, ResourceAssignment r, CancellationToken ct)
    {
        var target = PlanService.TargetOf(action);
        if (target.IsEmpty || await targets.PositionAsync(target, plan.LocationId, ct) is not { } to || await OriginAsync(v, r.FromStationId, ct) is not { } from) return null;
        return await EstimateAsync(v, from, to, plan.LocationId, PlanTiming.StartAt(plan, action), ct);
    }

    /// <summary>
    /// Vê se uma rota enviada por um cliente anda mesmo na rede viária: cada vértice, e os pontos entre vértices (a cada `RouteToleranceM`), têm de estar a menos de `RouteToleranceM` de uma estrada.
    /// </summary>
    public async Task<ValidationIssue?> CheckRouteAsync(LineString route, string locationId, string pointer, CancellationToken ct)
    {
        var network = await map.GetRoadsAsync(locationId, ct);
        // o resultado só depende da rota e da rede: os planos de um mesmo pedido repetem as mesmas rotas (mesmo meio, mesmo alvo) e cada uma custava dezenas de milhares de
        // consultas ao índice espacial; guarda-se por rede (outra rede, outras estradas) e pelo conteúdo da rota
        var known = _routeChecks.GetOrCreateValue(network);
        string key = RouteKey(route);
        if (!known.TryGetValue(key, out var message))
        {
            message = OffNetworkMessage(queries.IndexOf(network), route);
            if (known.Count < MaxRememberedRoutes) known[key] = message;
        }
        return message is null ? null : new("error", "route_off_network", message, pointer);
    }

    const int MaxRememberedRoutes = 20_000;
    readonly System.Runtime.CompilerServices.ConditionalWeakTable<RoadNetwork, System.Collections.Concurrent.ConcurrentDictionary<string, string?>> _routeChecks = new();

    static string RouteKey(LineString route)
    {
        var c = route.Coordinates;
        var bytes = new byte[c.Length * 16];
        for (int i = 0; i < c.Length; i++)
        {
            BitConverter.TryWriteBytes(bytes.AsSpan(i * 16, 8), c[i].X);
            BitConverter.TryWriteBytes(bytes.AsSpan(i * 16 + 8, 8), c[i].Y);
        }
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes));
    }

    /// <summary>Nulo se a rota anda na rede; senão, onde sai dela.</summary>
    string? OffNetworkMessage(RoadIndex index, LineString route)
    {
        var c = route.Coordinates;
        for (int i = 0; i < c.Length; i++)
        {
            // vértices e, entre dois vértices, um ponto a cada `RouteToleranceM`: uma corda reta por cima do mato não passa
            int steps = i == 0 ? 1 : Math.Max(1, (int)Math.Ceiling(RoadGeometry.DistanceM(c[i - 1].Y, c[i - 1].X, c[i].Y, c[i].X) / settings.RouteToleranceM));
            for (int k = 1; k <= steps; k++)
            {
                var p = i == 0 ? c[0] : new Coordinate(c[i - 1].X + (c[i].X - c[i - 1].X) * k / steps, c[i - 1].Y + (c[i].Y - c[i - 1].Y) * k / steps);
                if (index.Nearest(p.Y, p.X, settings.RouteToleranceM) is null)
                    return $"A rota sai da rede viária perto de {p.Y:F5}, {p.X:F5} (a mais de {settings.RouteToleranceM:F0} m de qualquer estrada): as viaturas só andam por estrada.";
            }
        }
        return null;
    }
}
