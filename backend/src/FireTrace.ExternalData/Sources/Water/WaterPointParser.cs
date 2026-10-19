using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Water;

public static class WaterPointParser
{
    /// <summary>Nós e vias com `center` (+ `bounds`): hidrantes, tanques, torres de água e piscinas.</summary>
    public static WaterPoint? FromPoint(JsonElement el, GridSpec spec, WaterOptions o)
    {
        var pos = OsmJson.Position(el);
        if (pos is null) return null;
        var (lat, lon) = pos.Value;
        var (x, y) = spec.ToCell(lat, lon);
        if (!spec.Inside(x, y)) return null;
        string? emergency = OsmJson.Tag(el, "emergency"), manMade = OsmJson.Tag(el, "man_made"), leisure = OsmJson.Tag(el, "leisure");
        double? area = el.TryGetProperty("bounds", out var b) ? LocalMetres.BoxAreaM2(b) * o.BoundsAreaFactor : null; // caixa envolvente → área aproximada
        string osm = $"{el.GetProperty("type").GetString()}/{el.GetProperty("id").GetInt64()}";
        string name = OsmJson.Tag(el, "name") ?? "", refTag = OsmJson.Tag(el, "ref") ?? OsmJson.Tag(el, "fire_hydrant:ref") ?? "";
        string? Ref() => refTag == "" ? null : refTag;
        var access = WaterTags.AccessOf(el);

        if (emergency == "fire_hydrant")
        {
            var type = OsmJson.Tag(el, "fire_hydrant:type");
            return new WaterPoint(0, WaterPointKind.Hydrant, name != "" ? name : Ref() is { } r ? $"Boca de incêndio {r}" : "Boca de incêndio", lat, lon, Ref(), null, false,
                null, null, WaterTags.Num(OsmJson.Tag(el, "fire_hydrant:diameter")), type, true, false, null, null, access == "unknown" ? "public" : access, "osm", osm);
        }
        if (emergency == "suction_point")
            return new WaterPoint(0, WaterPointKind.DryHydrant, name != "" ? name : "Ponto de aspiração", lat, lon, Ref(), null, false, null, null, null, null, true, false, null, null, access, "osm", osm);
        if (emergency == "fire_water_pond")
            return WaterPointFactory.Body(WaterPointKind.Pond, name != "" ? name : "Charca de combate a incêndios", lat, lon, area, Ref(), access, osm, o, WaterTags.Num(OsmJson.Tag(el, "water_tank:volume")));
        if (emergency == "water_tank" || manMade == "water_tower" || (manMade == "storage_tank" && OsmJson.Tag(el, "content") == "water") || (manMade == "water_tank"))
        {
            double? vol = WaterTags.Num(OsmJson.Tag(el, "water_tank:volume") ?? OsmJson.Tag(el, "volume") ?? OsmJson.Tag(el, "capacity"));
            double? litres = vol is null ? null : vol <= o.TankVolumeLitresThreshold ? vol * 1000 : vol; // m³ por omissão; valores muito grandes assumem-se já em litros
            return new WaterPoint(0, WaterPointKind.Tank, name != "" ? name : manMade == "water_tower" ? "Torre de água" : "Reservatório de água", lat, lon, Ref(), litres, false, null, area, null, null,
                true, false, null, null, access, "osm", osm);
        }
        if (leisure == "swimming_pool")
        {
            if (area is { } poolArea && poolArea < o.MinPoolAreaM2) return null;
            return new WaterPoint(0, WaterPointKind.SwimmingPool, name != "" ? name : "Piscina", lat, lon, null, area is null ? null : area * o.PoolDepthM * 1000, area is not null, null, area, null, null,
                false, false, null, null, access, "osm", osm);
        }
        return null;
    }
}
