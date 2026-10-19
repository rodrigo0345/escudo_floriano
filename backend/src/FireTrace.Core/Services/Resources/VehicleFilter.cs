using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Models.Resources;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Resources;

/// <summary>Turns the filters of `GET /vehicles` into a predicate. A vehicle without its own position is where its station is.</summary>
public sealed class VehicleFilter(OwnerFilter owners, IDocumentStore<Station> stations)
{
    public async Task<Func<Vehicle, bool>> BuildAsync(VehicleQuery q, CancellationToken ct)
    {
        var owned = await owners.BuildAsync<Vehicle>(q.Owner, v => v.OrganizationId, v => v.StationId, ct);
        var stationPositions = q.Near is null ? null : (await stations.ListAsync(ct)).ToDictionary(s => s.Id, s => s.Position);

        return v => owned(v)
            && (q.Types.Count == 0 || q.Types.Contains(v.Type))
            && (q.Statuses.Count == 0 || q.Statuses.Contains(v.State.Status))
            && (q.Responsibilities.Count == 0 || (v.State.Responsibility is { } r && q.Responsibilities.Contains(r)))
            && (q.Capabilities.Count == 0 || (v.Capabilities?.Any(q.Capabilities.Contains) ?? false))
            && (q.OffRoad is null || v.OffRoad == q.OffRoad)
            && (q.InService is null || v.InService == q.InService)
            && (q.Near is not { } at || (PositionOf(v, stationPositions!) is { } p && RoadGeometry.DistanceM(at.Lat, at.Lon, p.Lat, p.Lon) <= (q.RadiusM ?? double.MaxValue)));
    }

    static LatLon? PositionOf(Vehicle v, Dictionary<string, LatLon> stationPositions) =>
        v.State.Position ?? (v.StationId is { } s && stationPositions.TryGetValue(s, out var p) ? p : null);
}
