using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Roads;

/// <summary>Estradas e caminhos florestais do OSM (pavimentadas, serviço e caminhos) como grafo.</summary>
public sealed class OsmRoadsSource(OverpassClient overpass, OverpassOptions overpassOptions, RoadOptions roads)
{
    public async Task<(List<RoadEdge> Edges, List<RoadNode> Nodes)> BuildAsync(GridSpec spec)
    {
        var ways = new Dictionary<long, JsonElement>();
        await overpass.ForEachBlockAsync(spec, overpassOptions.Blocks.RoadsM, async box =>
        {
            var bb = OverpassBbox.Of(box, overpassOptions.BboxPadDegrees);
            using var paved = await overpass.QueryAsync(RoadQueries.Paved(overpass.Prefix(), roads, bb));
            AddWays(ways, paved);
            using var minor = await overpass.QueryAsync(RoadQueries.Minor(overpass.Prefix(), roads, bb));
            AddWays(ways, minor);
            return $"{ways.Count} vias";
        });
        return RoadGraphBuilder.Build(ways.Values, spec);
    }

    // `Clone` because the document is disposed when the block ends
    static void AddWays(Dictionary<long, JsonElement> ways, JsonDocument doc)
    {
        foreach (var el in OsmJson.Elements(doc)) ways.TryAdd(el.GetProperty("id").GetInt64(), el.Clone());
    }
}
