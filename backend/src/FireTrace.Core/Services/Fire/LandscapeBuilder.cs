using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Fuel;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Models.Fire;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Fire;

/// <summary>
/// Traduz o terreno do local para as entradas dos motores de fogo (ELMFIRE e nativo): a paisagem de 8 bandas (relevo, declive, exposição, combustível Scott &amp; Burgan,
/// cobertura/altura/base/densidade do copado) e o fator de ajuste da velocidade de propagação (fuel, edifícios, humidade ribeirinha, variabilidade e aceiros) mais as barreiras (estradas e rios).
/// Os valores vêm de `FireTrace:Landscape` e `FireTrace:Fuels` (appsettings.json).
/// </summary>
public sealed class LandscapeBuilder(LandscapeSettings settings, FuelCatalog fuels)
{
    public double BuiltFraction(TerrainGrids g, int cell) => Math.Min(1.0, g.Buildings[cell] * settings.HouseFootprintM2 / (g.Spec.CellM * g.Spec.CellM));

    /// <summary>Bandas Int16 (band-sequential, linha 0 = norte): dem, slp, asp, fbfm40, cc, ch×10, cbh×10, cbd×100.</summary>
    public short[] Bands(TerrainGrids g)
    {
        int n = g.Spec.CellCount;
        var b = new short[8 * n];
        for (int c = 0; c < n; c++)
        {
            var fm = fuels.Get(g.LandCover[c]);
            int fbfm = fm.Fbfm40;
            double built = BuiltFraction(g, c);
            if (built > settings.DenseBuiltThreshold && fbfm >= settings.MinFlammableFuelModel) fbfm = settings.UrbanFuelModel; // aglomerado denso: sem combustível contínuo
            double open = 1 - built;                    // as casas ocupam parte do copado e do solo
            b[0 * n + c] = (short)Math.Round(g.Elevation[c]);
            b[1 * n + c] = (short)Math.Round(g.Slope[c]);
            b[2 * n + c] = (short)Math.Round(g.Aspect[c]);
            b[3 * n + c] = (short)fbfm;
            b[4 * n + c] = (short)Math.Round(fm.CanopyCoverPct * open);
            b[5 * n + c] = (short)Math.Round(fm.CanopyHeightM * 10);
            b[6 * n + c] = (short)Math.Round(fm.CanopyBaseHeightM * 10);
            b[7 * n + c] = (short)Math.Round(fm.CanopyBulkDensity * 100);
        }
        return b;
    }

    /// <summary>
    /// As bandas com o combustível cortado: sem árvores perdem o copado (e o fogo de copas), sem sub-bosque ficam com o combustível de pasto curto,
    /// e "tudo" deixa solo nu. Devolve uma cópia (as bandas do local são partilhadas entre simulações).
    /// </summary>
    public short[] Treat(short[] bands, int cellCount, IEnumerable<FuelTreatment> treatments, FuelRemovalSettings removal)
    {
        var result = (short[])bands.Clone();
        foreach (var t in treatments)
            foreach (int c in t.Cells)
            {
                if (t.Removal is FuelRemoval.Trees or FuelRemoval.All) for (int band = BandCanopyCover; band <= BandCanopyBulkDensity; band++) result[band * cellCount + c] = 0;
                if (t.Removal == FuelRemoval.Understory) result[BandFuel * cellCount + c] = (short)removal.UnderstoryFuelModel;
                else if (t.Removal == FuelRemoval.All) result[BandFuel * cellCount + c] = (short)removal.NonBurnableFuelModel;
            }
        return result;
    }

    const int BandFuel = 3, BandCanopyCover = 4, BandCanopyBulkDensity = 7;

    /// <summary>
    /// Fator multiplicativo da velocidade de propagação por célula, sem as barreiras (essas dependem do vento de cada membro, ver <see cref="BarrierSet"/>):
    /// calibração local de cada vegetação, edifícios (até −70% em células totalmente construídas), humidade junto à água, variabilidade e aceiros mantidos.
    /// </summary>
    public float[] Adjustment(TerrainGrids g, IEnumerable<Firebreak> firebreaks, IEnumerable<Waterway> waterways)
    {
        var adj = new float[g.Spec.CellCount];
        float min = (float)settings.MinAdjustmentFactor;
        var variability = settings.SpreadVariability;
        var noise = variability.Amplitude > 0 ? SpreadNoise.Field(g.Spec.Width, g.Spec.Height, variability.CorrelationCells, variability.Seed) : null;
        var waterDistance = WaterDistance(g, waterways);
        for (int c = 0; c < adj.Length; c++)
            adj[c] = (float)((1 - settings.BuiltAreaSpreadSlowdown * BuiltFraction(g, c)) * fuels.Get(g.LandCover[c]).SpreadFactor * settings.SpreadCalibration)
                * WaterInfluence.RiparianFactor(waterDistance[c], settings.Riparian) * (noise is null ? 1f : SpreadNoise.Factor(noise[c], variability.Amplitude));
        foreach (var fb in firebreaks.Where(f => f.Maintained))
            foreach (int c in Zones.CellsOf(g.Spec, fb.Geometry, 0)) adj[c] = Math.Max(min, Math.Min(adj[c], (float)settings.FirebreakFactor));
        return adj;
    }

    /// <summary>Distância de cada célula à água fresca: lagos e albufeiras (vegetação «Água») e os cursos de água de `Riparian.WaterwayKinds`.</summary>
    float[] WaterDistance(TerrainGrids g, IEnumerable<Waterway> waterways)
    {
        var isWater = new bool[g.Spec.CellCount];
        for (int c = 0; c < isWater.Length; c++) isWater[c] = g.LandCover[c] == LandCover.Agua;
        foreach (var w in waterways.Where(w => settings.Riparian.WaterwayKinds.Contains(EnumText.ToSnake(w.Kind))))
            foreach (int c in Zones.CellsOf(g.Spec, w.Geometry, 0)) isWater[c] = true;
        return WaterInfluence.DistanceM(isWater, g.Spec.Width, g.Spec.Height, g.Spec.CellM);
    }

    /// <summary>A força das barreiras por célula (0–3), para mostrar no mapa.</summary>
    public byte[] BarrierStrength(TerrainGrids g, RoadNetwork roads, IEnumerable<Waterway> waterways) => BarrierSet.Build(g.Spec, roads, waterways, settings.Barriers).Strength(g.Spec.CellCount);

    /// <summary>Quanto a água fresca trava o fogo em cada célula (0–100 %), para mostrar no mapa.</summary>
    public byte[] RiparianSlowdownPct(TerrainGrids g, IEnumerable<Waterway> waterways) =>
        WaterDistance(g, waterways).Select(d => (byte)Math.Round(100 * (1 - WaterInfluence.RiparianFactor(d, settings.Riparian)))).ToArray();

    /// <summary>Tudo o que o motor precisa do terreno de um local: as bandas, a propagação base e as barreiras (que se aplicam por membro).</summary>
    public Landscape Build(TerrainGrids g, RoadNetwork roads, IReadOnlyList<Firebreak> firebreaks, IReadOnlyList<Waterway> waterways) =>
        new(Bands(g), Adjustment(g, firebreaks, waterways), BarrierSet.Build(g.Spec, roads, waterways, settings.Barriers));
}
