using FireTrace.ExternalData.Sources.Waterways;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Rios, canais e ribeiras (OSM): barreiras naturais à propagação do fogo.</summary>
public sealed class WaterwaysStep(OsmWaterwaysSource waterways, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "waterways";
    public int Order => 85;

    public async Task RunAsync(IngestContext ctx)
    {
        var items = await waterways.FetchAsync(ctx.Spec);
        log.Info("  " + string.Join(", ", items.GroupBy(w => w.Kind).Select(g => $"{g.Key}={g.Count()}")));
        await writer.ReplaceWaterwaysAsync(ctx.Id, items);
    }
}
