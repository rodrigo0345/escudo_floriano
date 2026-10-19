using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Sources.Water;
using FireTrace.ExternalData.Store;
using Microsoft.Extensions.DependencyInjection;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Bocas de incêndio e pontos de água, ligados às estradas (precisa de as estradas já estarem carregadas).</summary>
public sealed class WaterStep(WaterSource waterSource, WaterOptions options, IMapWriter writer, [FromKeyedServices(ExternalDataServiceKeys.UncachedReader)] IMapReader reader, IIngestLog log) : IIngestStep
{
    public string Name => "water";
    public int Order => 80;

    public async Task RunAsync(IngestContext ctx)
    {
        var points = await waterSource.FetchAsync(ctx.Spec);
        // the roads were written by the previous step: read them straight from the database, never through the reader cache
        points = WaterRoadLinker.LinkToRoads(points, await reader.GetRoadsAsync(ctx.Id), options);
        log.Info("  " + string.Join(", ", points.GroupBy(w => w.Kind).Select(g => $"{g.Key}={g.Count()}")) + $"; acessíveis a autotanque: {points.Count(w => w.TruckAccessible)}");
        await writer.ReplaceWaterPointsAsync(ctx.Id, points);
    }
}
