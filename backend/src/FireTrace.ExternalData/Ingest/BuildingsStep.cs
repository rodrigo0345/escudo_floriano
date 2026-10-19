using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Buildings;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Edifícios por célula (a população estimada deriva daqui).</summary>
public sealed class BuildingsStep(OsmBuildingsSource buildings, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "buildings";
    public int Order => 60;

    public async Task RunAsync(IngestContext ctx)
    {
        var counts = await buildings.CountPerCellAsync(ctx.Spec);
        log.Info($"  {counts.Sum(c => (long)c)} edifícios em {counts.Count(c => c > 0)} células (máx. {counts.Max()} por célula)");
        await writer.SaveGridAsync(ctx.Id, "buildings", new GridBlob(ctx.Spec.Width, ctx.Spec.Height, ctx.Spec.CellM, "u16", GridBytes.Of(counts)));
    }
}
