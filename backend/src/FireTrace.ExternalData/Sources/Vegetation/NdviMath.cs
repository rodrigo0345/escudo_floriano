namespace FireTrace.ExternalData.Sources.Vegetation;

public static class NdviMath
{
    /// <summary>NDVI de um píxel, ou nada se ambas as bandas são zero (fora da faixa de dados do tile).</summary>
    public static float? Compute(int red, int nir) => red <= 0 && nir <= 0 ? null : (float)(nir - red) / Math.Max(nir + red, 1);
}
