using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;
using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Sources.Waterways;

/// <summary>
/// Rios, canais e ribeiras do OSM (`waterway=*`) como linhas. O leito e a vegetação ribeirinha travam o fogo, por isso a API usa-os no ajuste da
/// propagação (`LandscapeBuilder`). As massas de água (lagos, albufeiras) já estão na vegetação (WorldCover «Água»).
/// </summary>
public sealed class OsmWaterwaysSource(OverpassClient overpass, OverpassOptions overpassOptions, WaterwayOptions waterways)
{
    public async Task<List<Waterway>> FetchAsync(GridSpec spec)
    {
        var tags = string.Join("|", waterways.OsmWaterwayTags.Keys);
        var b = spec.Bounds;
        var area = Wgs84.Factory.ToGeometry(new Envelope(b.West, b.East, b.South, b.North));
        var seen = new HashSet<long>();
        var result = new List<Waterway>();
        await overpass.ForEachBlockAsync(spec, overpassOptions.Blocks.WaterwaysM, async box =>
        {
            using var doc = await overpass.QueryAsync($"{overpass.Prefix()}way[\"waterway\"~\"^({tags})$\"]{OverpassBbox.Of(box)};out geom tags;");
            foreach (var el in OsmJson.Elements(doc))
            {
                if (!seen.Add(el.GetProperty("id").GetInt64()) || !el.TryGetProperty("geometry", out var g) || g.GetArrayLength() < 2) continue;
                if (WaterwayParser.Parse(el, area, waterways) is { } waterway) result.Add(waterway);
            }
            return $"{result.Count} cursos de água";
        });
        return result;
    }
}
