using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Terrain;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Relevo (AWS Terrain Tiles): grelha de simulação e malha mais fina para desenhar.</summary>
public sealed class TerrainStep(TerrariumSource terrarium, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "terrain";
    public int Order => 10;

    public async Task RunAsync(IngestContext ctx)
    {
        var mosaic = await terrarium.LoadAsync(ctx.Spec.Bounds);
        var dem = mosaic.Sample(ctx.Spec);
        var render = ctx.Location.RenderSpec;
        log.Info($"  {dem.Min():F0}–{dem.Max():F0} m; malha de render {render.Width}x{render.Height}");
        await writer.SaveGridAsync(ctx.Id, "dem", new GridBlob(ctx.Spec.Width, ctx.Spec.Height, ctx.Spec.CellM, "f32", GridBytes.Of(dem)));
        await writer.SaveGridAsync(ctx.Id, "dem_render", new GridBlob(render.Width, render.Height, render.CellM, "f32", GridBytes.Of(mosaic.Sample(render))));
    }
}
