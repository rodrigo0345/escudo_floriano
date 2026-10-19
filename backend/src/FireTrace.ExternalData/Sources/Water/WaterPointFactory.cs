using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Water;

public static class WaterPointFactory
{
    /// <summary>Massa de água (charca ou albufeira): a capacidade é o volume indicado ou, se não houver, uma estimativa pela área e profundidade típica.</summary>
    public static WaterPoint Body(WaterPointKind kind, string name, double lat, double lon, double? area, string? refTag, string access, string osm, WaterOptions o, double? volumeM3 = null)
    {
        double depth = kind == WaterPointKind.Reservoir ? o.ReservoirDepthM : o.PondDepthM;
        double? cap = volumeM3 is not null ? volumeM3 * 1000 : area is null ? null : area * depth * 1000;
        return new WaterPoint(0, kind, name, lat, lon, refTag, cap, volumeM3 is null && cap is not null, null, area, null, null, false,
            kind != WaterPointKind.SwimmingPool && area.GetValueOrDefault() >= o.HelicopterMinAreaM2, null, null, access, "osm", osm);
    }
}
