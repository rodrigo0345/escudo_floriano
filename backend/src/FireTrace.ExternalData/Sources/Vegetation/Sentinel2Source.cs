using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Ingest;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Http;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Sentinel-2 L2A (AWS Earth Search): o NDVI de inverno e de verão, lido por pixel dos COGs das bandas.</summary>
public sealed class Sentinel2Source(HttpFetcher http, LandCoverOptions options, IIngestLog log)
{
    /// <summary>NDVI de inverno e de verão (por pixel da grelha WorldCover); NaN onde não há dados. Só calcula para pixéis de árvores de folha larga.</summary>
    public async Task<PhenologyNdvi> PhenologyAsync(GeoBounds ext, int w, int h, int year, byte[] wc, byte[] hrl)
    {
        using var winter = await OpenScenesAsync(ext, $"{year}-{options.WinterRange.From}T00:00:00Z/{year}-{options.WinterRange.To}T23:59:59Z");
        using var summer = await OpenScenesAsync(ext, $"{year}-{options.SummerRange.From}T00:00:00Z/{year}-{options.SummerRange.To}T23:59:59Z");
        if (winter.Count == 0 || summer.Count == 0) throw new InvalidOperationException("sem cenas Sentinel-2 com pouca nebulosidade");
        log.Info($"  Sentinel-2: inverno {string.Join(",", winter.Ids)}; verão {string.Join(",", summer.Ids)}");
        var nw = new float[w * h]; var ns = new float[w * h];
        Array.Fill(nw, float.NaN); Array.Fill(ns, float.NaN);
        double lonSpan = ext.East - ext.West, latSpan = ext.North - ext.South;
        for (int j = 0; j < h; j++)
        {
            double lat = ext.North - (j + 0.5) / h * latSpan;
            for (int i = 0; i < w; i++)
            {
                int k = j * w + i;
                if (wc[k] != ForestCodes.WorldCoverTrees || hrl[k] != ForestCodes.HrlBroadleaf) continue; // só árvores de folha larga
                double lon = ext.West + (i + 0.5) / w * lonSpan;
                nw[k] = winter.Sample(lat, lon); ns[k] = summer.Sample(lat, lon);
            }
        }
        return new PhenologyNdvi(nw, ns);
    }

    async Task<Sentinel2NdviSampler> OpenScenesAsync(GeoBounds e, string range)
    {
        using var doc = JsonDocument.Parse(await http.PostJsonAsync(options.EarthSearchUrl, StacSearchBody.Build(options, e, range)));
        var scenes = new List<Sentinel2Scene>();
        try
        {
            foreach (var info in StacSceneParser.Parse(doc.RootElement)) scenes.Add(await Sentinel2Scene.OpenAsync(http, info));
        }
        catch { foreach (var scene in scenes) scene.Dispose(); throw; }
        return new Sentinel2NdviSampler(scenes);
    }
}
