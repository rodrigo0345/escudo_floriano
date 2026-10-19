using FireTrace.ExternalData.Sources.Roads;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Estradas e caminhos florestais (OSM).</summary>
public sealed class RoadsStep(OsmRoadsSource roads, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "roads";
    public int Order => 50;

    public async Task RunAsync(IngestContext ctx)
    {
        var (edges, nodes) = await roads.BuildAsync(ctx.Spec);
        log.Info($"  {edges.Count} troços ({edges.Count(e => e.OffRoad)} caminhos todo-o-terreno), {nodes.Count} nós");
        await writer.ReplaceRoadsAsync(ctx.Id, ctx.Spec, edges, nodes);
    }
}
