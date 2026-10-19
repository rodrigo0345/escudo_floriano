using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Buildings;

/// <summary>Nº de edifícios (OSM building=*) por célula da grelha de simulação.</summary>
public sealed class OsmBuildingsSource(OverpassClient overpass, OverpassOptions options)
{
    public async Task<ushort[]> CountPerCellAsync(GridSpec spec)
    {
        var counter = new BuildingCellCounter(spec);
        await overpass.ForEachBlockAsync(spec, options.Blocks.BuildingsM, async box =>
        {
            var bb = OverpassBbox.Of(box);
            using var d = await overpass.QueryAsync($"{overpass.Prefix()}(node[\"building\"]{bb};way[\"building\"]{bb};relation[\"building\"]{bb};);out center;");
            counter.Add(OsmJson.Elements(d));
            return $"{counter.BuildingCount} edifícios";
        });
        return counter.Grid;
    }
}
