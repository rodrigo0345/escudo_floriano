using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Imagery;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Ortofotos de alta resolução da DGT (≈1,4 m/píxel), em blocos.</summary>
public sealed class OrthophotoStep(DgtOrthoSource ortho, OrthoOptions options, ExternalDataPaths paths, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "ortho";
    public int Order => 40;

    public async Task RunAsync(IngestContext ctx)
    {
        var loc = ctx.Location;
        if (loc.OrthoTiles <= 0) { log.Info("  desligado neste local"); return; }
        var tiles = await ortho.BuildAsync(ctx.Spec.Bounds, loc.OrthoTiles, loc.OrthoTilePixels, Path.Combine(paths.DataDir, "imagery", loc.Id));
        foreach (var (tx, ty, path) in tiles)
            await writer.SaveImageryAsync(new ImageryAsset(loc.Id, $"ortho_{tx}_{ty}", options.Source, loc.OrthoTiles, $"imagery/{loc.Id}/{Path.GetFileName(path)}", ctx.Spec.Bounds, options.Attribution));
    }
}
