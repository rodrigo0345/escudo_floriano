using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Ingest;
using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>
/// Mapa de combustível com espécies a partir de dados abertos:
///  - ESA WorldCover 2021 (10 m): cobertura (árvores, mato, pasto, cultivo, urbano, água…)
///  - Copernicus HRL Forest Type 2018 (10 m): folhosas vs coníferas
///  - Sentinel-2 L2A (AWS Earth Search): fenologia (NDVI inverno vs verão) para separar folha perene (eucaliptal) de folha caduca (carvalhal, castanheiro)
/// Não há mapa público de espécies para esta zona (a COS 2018 ao nível das espécies não está exposta em serviços com geometria),
/// por isso o "eucaliptal" é uma inferência por fenologia, marcada como provável.
/// </summary>
public sealed class SpeciesMapBuilder(WorldCoverSource worldCover, HrlSource hrlSource, Sentinel2Source sentinel2, LandCoverOptions options, IIngestLog log)
{
    public async Task<SpeciesMap> BuildAsync(GridSpec spec, int year)
    {
        var window = await worldCover.ReadWindowAsync(spec);
        int ww = window.Width, hh = window.Height;
        log.Info($"  WorldCover {ww}x{hh} px");
        byte[]? hrl = null;
        PhenologyNdvi? ndvi = null;
        try { hrl = await hrlSource.ReadAsync(window.Extent, ww, hh); log.Info("  HRL Forest Type 2018 ok"); }
        catch (Exception e) { log.Warn($"  HRL indisponível ({e.Message}); folhosas ficam como floresta mista"); }
        if (hrl is not null)
        {
            try { ndvi = await sentinel2.PhenologyAsync(window.Extent, ww, hh, year, window.Data, hrl); }
            catch (Exception e) { log.Warn($"  Sentinel-2 indisponível ({e.Message}); sem separação eucalipto/folhosas"); }
        }
        if (ndvi is not null)
        {
            var (winter, amplitude) = NdviSummary.Percentiles(ndvi.Winter, ndvi.Summer);
            log.Info($"  NDVI inverno (folha larga): {winter}");
            log.Info($"  amplitude verão-inverno:    {amplitude}");
        }
        var trees = TreeSpeciesClassifier.Classify(window.Data, hrl, ndvi?.Winter, ndvi?.Summer, options);
        log.Info($"  árvores: coníferas {trees.Conifers}, folha perene (eucalipto) {trees.Evergreen}, folha caduca {trees.Deciduous}");
        var cover = CoverAggregator.Majority(trees.Fine, ww, hh, spec);
        return new SpeciesMap(cover, MethodOf(hrl, ndvi), trees.Fine, ww, hh, window.Extent);
    }

    static string MethodOf(byte[]? hrl, PhenologyNdvi? ndvi) =>
        ndvi is null ? (hrl is null ? "worldcover" : "worldcover+hrl") : "worldcover+hrl+sentinel2-fenologia";
}
