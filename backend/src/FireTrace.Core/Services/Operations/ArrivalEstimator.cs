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

    /// <summary>O local que contém o ponto (o indicado, se houver, ou o primeiro que o cobre).</summary>
    public string? LocationOf(LatLon p, string? locationId = null) => locationId ?? map.Locations.All.FirstOrDefault(l => l.Spec.CellAt(p.Lat, p.Lon) >= 0)?.Id;

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

        var location = LocationOf(to, locationId);
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
        var index = queries.IndexOf(await map.GetRoadsAsync(locationId, ct));
        var c = route.Coordinates;
        for (int i = 0; i < c.Length; i++)
        {
            // vértices e, entre dois vértices, um ponto a cada `RouteToleranceM`: uma corda reta por cima do mato não passa
            int steps = i == 0 ? 1 : Math.Max(1, (int)Math.Ceiling(RoadGeometry.DistanceM(c[i - 1].Y, c[i - 1].X, c[i].Y, c[i].X) / settings.RouteToleranceM));
            for (int k = 1; k <= steps; k++)
            {
                var p = i == 0 ? c[0] : new Coordinate(c[i - 1].X + (c[i].X - c[i - 1].X) * k / steps, c[i - 1].Y + (c[i].Y - c[i - 1].Y) * k / steps);
                if (index.Nearest(p.Y, p.X, settings.RouteToleranceM) is null)
                    return new("error", "route_off_network", $"A rota sai da rede viária perto de {p.Y:F5}, {p.X:F5} (a mais de {settings.RouteToleranceM:F0} m de qualquer estrada): as viaturas só andam por estrada.", pointer);
            }
        }
        return null;
    }
}
