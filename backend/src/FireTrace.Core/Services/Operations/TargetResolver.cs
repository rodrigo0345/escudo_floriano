using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Services.Map;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>Descobre onde fica o alvo de uma ação ou despacho: uma posição, uma geometria, ou um lugar, instalação, ponto de água ou estrada do mapa.</summary>
public sealed class TargetResolver(IMapReader map)
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);

    public static Point PointAt(double lat, double lon) => Gf.CreatePoint(new Coordinate(lon, lat));

    /// <summary>A geometria do alvo (procura nos locais conhecidos se não se souber em qual está).</summary>
    public async Task<Geometry?> GeometryAsync(Target target, string? locationId = null, CancellationToken ct = default)
    {
        if (target.Geometry is not null) return target.Geometry;
        if (target.Position is { } p) return PointAt(p.Lat, p.Lon);
        foreach (var loc in map.Locations.All.Where(l => locationId is null || l.Id == locationId))
        {
            if (target.PlaceId is { } pid && (await map.GetPlacesAsync(loc.Id, ct)).FirstOrDefault(x => MapIds.Place(x.Id) == pid) is { } place) return PointAt(place.Lat, place.Lon);
            if (target.FacilityId is { } fid && (await map.GetFacilitiesAsync(loc.Id, ct)).FirstOrDefault(x => MapIds.Facility(x.Id) == fid) is { } facility) return PointAt(facility.Lat, facility.Lon);
            if (target.WaterPointId is { } wid && (await map.GetWaterPointsAsync(loc.Id, ct)).FirstOrDefault(x => MapIds.Water(x.Id) == wid) is { } water) return PointAt(water.Lat, water.Lon);
            if (MapIds.RoadNumber(target.RoadId) is { } rid)
            {
                var net = await map.GetRoadsAsync(loc.Id, ct);
                if (net.Edges.FirstOrDefault(e => e.Id == rid) is { } edge && edge.Pts.Length >= 2)
                {
                    int mid = edge.Pts.Length / 4 * 2;
                    var (lat, lon) = net.Spec.ToLatLon(edge.Pts[mid], edge.Pts[mid + 1]);
                    return PointAt(lat, lon);
                }
            }
        }
        return null;
    }

    public async Task<LatLon?> PositionAsync(Target target, string? locationId = null, CancellationToken ct = default) =>
        await GeometryAsync(target, locationId, ct) is { } g ? new LatLon(g.Centroid.Y, g.Centroid.X) : null;
}
