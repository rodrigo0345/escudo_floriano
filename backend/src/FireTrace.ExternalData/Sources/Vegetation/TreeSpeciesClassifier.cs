using System.Globalization;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

public static class TreeSpeciesClassifier
{
    /// <summary>
    /// Classe de combustível de cada píxel WorldCover: a cobertura do solo, com as árvores separadas em coníferas (HRL) e, nas folhosas,
    /// folha perene (eucalipto) de folha caduca pela fenologia (NDVI). Sem HRL ou sem NDVI, as árvores ficam na classe do WorldCover.
    /// </summary>
    public static SpeciesClassification Classify(byte[] wc, byte[]? hrl, float[]? ndviWinter, float[]? ndviSummer, LandCoverOptions lc)
    {
        var fine = new byte[wc.Length];
        int ev = 0, dec = 0, con = 0;
        var classOf = lc.WorldCoverClasses.ToDictionary(kv => int.Parse(kv.Key, CultureInfo.InvariantCulture), kv => LandCover.IdOf(kv.Value));
        byte defaultClass = LandCover.IdOf(lc.WorldCoverDefaultClass);
        for (int i = 0; i < fine.Length; i++)
        {
            byte c = classOf.TryGetValue(wc[i], out var mapped) ? mapped : defaultClass;
            if (wc[i] == ForestCodes.WorldCoverTrees && hrl is not null)
            {
                if (hrl[i] == ForestCodes.HrlConifer) { c = LandCover.Pinheiro; con++; }
                else if (hrl[i] == ForestCodes.HrlBroadleaf && ndviWinter is not null && !float.IsNaN(ndviWinter[i]) && !float.IsNaN(ndviSummer![i]))
                {
                    // folha perene = NDVI de inverno alto e queda no verão (seca estival do eucalipto); folha caduca = inverno mais baixo ou verão ≥ inverno.
                    // Limiares relativos à distribuição observada nesta zona (p25 de inverno ≈ 0,70; amplitude mediana ≈ -0,15), sem verdade de terreno.
                    bool evergreen = ndviWinter[i] >= lc.EvergreenMinWinterNdvi && ndviSummer[i] - ndviWinter[i] < lc.EvergreenMaxSummerDelta;
                    c = evergreen ? LandCover.Eucalipto : LandCover.Folhosas;
                    if (evergreen) ev++; else dec++;
                }
            }
            fine[i] = c;
        }
        return new SpeciesClassification(fine, ev, dec, con);
    }
}
