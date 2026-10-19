using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Water;

public static class WaterRoadLinker
{
    /// <summary>Liga cada ponto à estrada mais próxima: define se uma autotanque lá chega (≤ 60 m de uma via) e dá o troço para planear rotas.</summary>
    public static List<WaterPoint> LinkToRoads(IEnumerable<WaterPoint> points, RoadNetwork net, WaterOptions o)
    {
        var index = new RoadIndex(net);
        return points.Select(p =>
        {
            bool alwaysReachable = p.Kind is WaterPointKind.Hydrant or WaterPointKind.DryHydrant;
            if (index.Nearest(p.Lat, p.Lon, o.MaxRoadLinkM) is not var (edge, meters)) return p with { TruckAccessible = alwaysReachable };
            return p with { NearestRoadId = edge.Id, RoadDistanceM = Math.Round(meters, 1), TruckAccessible = alwaysReachable || meters <= o.TruckReachM };
        }).ToList();
    }
}
