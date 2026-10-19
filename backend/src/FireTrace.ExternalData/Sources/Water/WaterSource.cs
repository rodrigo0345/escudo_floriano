using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Water;

/// <summary>
/// Pontos de água a partir de elementos OSM: bocas de incêndio (hidrantes), pontos de aspiração, tanques, albufeiras, charcas e piscinas.
/// Capacidades e áreas de massas de água são ESTIMATIVAS geométricas (marcadas como tal): o OSM raramente tem volumes.
/// </summary>
public sealed class WaterSource(OverpassClient overpass, OverpassOptions overpassOptions, WaterOptions water)
{
    /// <summary>Descarrega os pontos de água do local (em blocos) e classifica-os; a ligação às estradas faz-se depois com <see cref="WaterRoadLinker"/>.</summary>
    public async Task<List<WaterPoint>> FetchAsync(GridSpec spec)
    {
        var seen = new HashSet<string>();
        var list = new List<WaterPoint>();
        await overpass.ForEachBlockAsync(spec, overpassOptions.Blocks.WaterM, async box =>
        {
            var bb = OverpassBbox.Of(box);
            using (var points = await overpass.QueryAsync(WaterQueries.Points(overpass.Prefix(), bb)))
                foreach (var el in OsmJson.Elements(points))
                    if (WaterPointParser.FromPoint(el, spec, water) is { } wp && seen.Add(wp.OsmId!)) list.Add(wp);
            using (var bodies = await overpass.QueryAsync(WaterQueries.Bodies(overpass.Prefix(), bb)))
                foreach (var el in OsmJson.Elements(bodies))
                    if (WaterBodyParser.FromWaterWay(el, spec, water) is { } wp && seen.Add(wp.OsmId!)) list.Add(wp);
            return $"{list.Count} pontos de água";
        });
        return list;
    }
}
