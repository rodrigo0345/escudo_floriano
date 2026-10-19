using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Water;

public static class WaterBodyParser
{
    /// <summary>Vias fechadas com `geometry` (natural=water, landuse=reservoir): ponto representativo dentro da água, ou o vértice da margem mais próximo do centróide.</summary>
    public static WaterPoint? FromWaterWay(JsonElement el, GridSpec spec, WaterOptions o)
    {
        string? natural = OsmJson.Tag(el, "natural"), landuse = OsmJson.Tag(el, "landuse"), water = OsmJson.Tag(el, "water");
        if (natural != "water" && landuse != "reservoir") return null;
        if (water is "river" or "canal" or "stream" or "stream_pool" or "oxbow" or "ditch" or "drain" or "wastewater" or "fountain" or "lock" or "moat" or "reflecting_pool") return null;
        if (!el.TryGetProperty("geometry", out var g) || g.GetArrayLength() < 4) return null;
        var pts = g.EnumerateArray().Select(p => (Lat: p.GetProperty("lat").GetDouble(), Lon: p.GetProperty("lon").GetDouble())).ToArray();
        if (pts[0] != pts[^1]) return null; // só polígonos fechados
        double lat0 = pts[0].Lat, lon0 = pts[0].Lon, k = Math.Cos(lat0 * Math.PI / 180);
        var xy = pts.Select(p => ((p.Lon - lon0) * LocalMetres.PerDegreeLonAtEquator * k, (p.Lat - lat0) * LocalMetres.PerDegreeLat)).ToArray();
        double area = LocalPolygon.Area(xy);
        if (area < o.MinWaterBodyAreaM2) return null;
        var (cx, cy) = LocalPolygon.Centroid(xy);
        (double X, double Y) rep = (cx, cy);
        if (!LocalPolygon.Contains(xy, cx, cy)) rep = xy.OrderBy(p => (p.Item1 - cx) * (p.Item1 - cx) + (p.Item2 - cy) * (p.Item2 - cy)).First();
        double lat = lat0 + rep.Y / LocalMetres.PerDegreeLat, lon = lon0 + rep.X / (LocalMetres.PerDegreeLonAtEquator * k);
        var (px, py) = spec.ToCell(lat, lon);
        if (!spec.Inside(px, py)) return null;
        var kind = water is "reservoir" || landuse == "reservoir" || water == "lake" || area >= o.ReservoirMinAreaM2 ? WaterPointKind.Reservoir : WaterPointKind.Pond;
        string defName = kind == WaterPointKind.Reservoir ? "Albufeira / lago" : "Charca / lagoa";
        return WaterPointFactory.Body(kind, OsmJson.Tag(el, "name") ?? defName, lat, lon, area, null, WaterTags.AccessOf(el), $"way/{el.GetProperty("id").GetInt64()}", o);
    }
}
