using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Imaging;
using FireTrace.ExternalData.Sources.Vegetation;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Vegetação por célula (WorldCover + HRL + fenologia Sentinel-2) e o combustível que o motor lhe atribui.</summary>
public sealed class VegetationStep(SpeciesMapBuilder speciesMap, ImageFileWriter images, LandCoverOptions options, ExternalDataPaths paths, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "landcover";
    public int Order => 20;

    public async Task RunAsync(IngestContext ctx)
    {
        var loc = ctx.Location;
        byte[] cover;
        if (loc.LandCoverSource == "uniform") cover = UniformLandCover.Create(ctx.Spec, options.UniformClass);
        else
        {
            var map = await speciesMap.BuildAsync(ctx.Spec, loc.PhenologyYear);
            cover = map.Cover;
            log.Info($"  método: {map.Method}");
            var rel = $"imagery/{loc.Id}/species.png";
            int px = options.SpeciesRasterPixels;
            images.SavePng(SpeciesRasterRenderer.Render(map, ctx.Spec, px), px, px, Path.Combine(paths.DataDir, rel));
            await writer.SaveImageryAsync(new ImageryAsset(loc.Id, "species", map.Method, 0, rel, ctx.Spec.Bounds, "ESA WorldCover 2021, Copernicus HRL Forest Type 2018, Sentinel-2 L2A (fenologia)"));
        }
        for (int id = 1; id < LandCover.Count; id++)
            log.Info($"  {LandCover.KeyOf(id),-12} {100.0 * cover.Count(x => x == id) / cover.Length:F1}%");
        await writer.SaveGridAsync(ctx.Id, "landcover", new GridBlob(ctx.Spec.Width, ctx.Spec.Height, ctx.Spec.CellM, "u8", cover));
    }
}
