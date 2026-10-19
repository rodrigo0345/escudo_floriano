using FireTrace.Core.Configuration;

namespace FireTrace.Core.Services.Fire;

/// <summary>A água fresca influencia o fogo à volta: distância de cada célula à água mais próxima (m) e o fator de propagação ribeirinho que daí sai.</summary>
public static class WaterInfluence
{
    /// <summary>Distância (m) à célula de água mais próxima, por transformada em dois varrimentos com pesos 1 e √2 (erro &lt; 8 %). Sem água: <see cref="float.MaxValue"/>.</summary>
    public static float[] DistanceM(bool[] isWater, int width, int height, double cellM)
    {
        const float Diagonal = 1.41421356f;
        var d = new float[isWater.Length];
        for (int i = 0; i < d.Length; i++) d[i] = isWater[i] ? 0 : float.MaxValue;
        float At(int x, int y) => x < 0 || y < 0 || x >= width || y >= height ? float.MaxValue : d[y * width + x];
        void Relax(int x, int y, params (int Dx, int Dy, float W)[] neighbours)
        {
            float best = d[y * width + x];
            foreach (var (dx, dy, w) in neighbours) { float v = At(x + dx, y + dy); if (v < float.MaxValue) best = Math.Min(best, v + w); }
            d[y * width + x] = best;
        }
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++) Relax(x, y, (-1, 0, 1), (0, -1, 1), (-1, -1, Diagonal), (1, -1, Diagonal));
        for (int y = height - 1; y >= 0; y--)
            for (int x = width - 1; x >= 0; x--) Relax(x, y, (1, 0, 1), (0, 1, 1), (1, 1, Diagonal), (-1, 1, Diagonal));
        for (int i = 0; i < d.Length; i++) if (d[i] < float.MaxValue) d[i] *= (float)cellM;
        return d;
    }

    /// <summary>Fração da propagação que resta a `distanceM` da água: 1 − Slowdown·exp(−d/DecayM), e 1 além de MaxDistanceM.</summary>
    public static float RiparianFactor(float distanceM, RiparianSettings s) =>
        distanceM >= s.MaxDistanceM ? 1f : (float)(1 - s.Slowdown * Math.Exp(-distanceM / s.DecayM));
}
