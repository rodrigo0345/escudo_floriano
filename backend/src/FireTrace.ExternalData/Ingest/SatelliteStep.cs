using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Imagery;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Imagem de satélite de recurso (EOX Sentinel-2 cloudless).</summary>
public sealed class SatelliteStep(EoxImagerySource eox, ImageryOptions options, ExternalDataPaths paths, IMapWriter writer) : IIngestStep
{
    public string Name => "imagery";
    public int Order => 30;

    public async Task RunAsync(IngestContext ctx)
    {
        var loc = ctx.Location;
        var rel = $"imagery/{loc.Id}/satellite.jpg";
        await eox.BuildAsync(ctx.Spec.Bounds, loc.ImageryZoom, loc.ImageryPixels, Path.Combine(paths.DataDir, rel));
        await writer.SaveImageryAsync(new ImageryAsset(loc.Id, "satellite", "eox-s2cloudless-2021", loc.ImageryZoom, rel, ctx.Spec.Bounds, options.EoxAttribution));
    }
}
