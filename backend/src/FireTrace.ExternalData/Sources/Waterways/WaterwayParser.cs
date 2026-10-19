using System.Globalization;
using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;
using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Sources.Waterways;

public static class WaterwayParser
{
    /// <summary>
    /// Um curso de água (via `waterway=*` com `geometry`) cortado pelo local, ou nada se não é uma barreira ou fica fora. <paramref name="bounds"/> é o
    /// polígono do local; só a parte da linha lá dentro interessa, porque fora da grelha as células seriam encostadas à borda.
    /// </summary>
    public static Waterway? Parse(JsonElement el, Geometry bounds, WaterwayOptions options)
    {
        var kind = Enum.Parse<WaterwayKind>(options.OsmWaterwayTags[OsmJson.Tag(el, "waterway")!], ignoreCase: true);
        if (!options.BarrierKinds.Contains(EnumText.ToSnake(kind))) return null;
        var g = el.GetProperty("geometry");
        var line = Wgs84.Factory.CreateLineString(g.EnumerateArray().Select(p => new Coordinate(p.GetProperty("lon").GetDouble(), p.GetProperty("lat").GetDouble())).ToArray());
        var inside = line.Intersection(bounds);
        if (inside.IsEmpty) return null;
        double? width = double.TryParse(OsmJson.Tag(el, "width"), NumberStyles.Float, CultureInfo.InvariantCulture, out var w) ? w : options.DefaultWidthM.GetValueOrDefault(EnumText.ToSnake(kind));
        return new Waterway(0, kind, OsmJson.Tag(el, "name"), width, inside);
    }
}
