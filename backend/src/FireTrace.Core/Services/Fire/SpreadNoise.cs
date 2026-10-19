namespace FireTrace.Core.Services.Fire;

/// <summary>
/// Variabilidade da velocidade de propagação que a grelha não resolve (combustível, microrrelevo, vento de lugar para lugar a menos de uma célula).
/// Sem ela, um terreno uniforme dá sempre uma elipse perfeita; com ela, a frente fica irregular como a de um incêndio real. É ruído de valor suave
/// (grelha de valores aleatórios interpolada) e determinista: o mesmo local e a mesma semente dão sempre o mesmo resultado.
/// </summary>
public static class SpreadNoise
{
    /// <summary>Um campo de valores em [0, 1] com manchas de cerca de `correlationCells` células.</summary>
    public static float[] Field(int width, int height, int correlationCells, int seed)
    {
        int step = Math.Max(1, correlationCells);
        var field = new float[width * height];
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                double fx = (double)x / step, fy = (double)y / step;
                int ix = (int)fx, iy = (int)fy;
                double tx = Smooth(fx - ix), ty = Smooth(fy - iy);
                double top = Lerp(Lattice(ix, iy, seed), Lattice(ix + 1, iy, seed), tx), bottom = Lerp(Lattice(ix, iy + 1, seed), Lattice(ix + 1, iy + 1, seed), tx);
                field[y * width + x] = (float)Lerp(top, bottom, ty);
            }
        return field;
    }

    /// <summary>O fator que multiplica a velocidade de propagação: 1 ± `amplitude`, com média 1.</summary>
    public static float Factor(float noise, double amplitude) => (float)(1 + amplitude * (2 * noise - 1));

    static double Smooth(double t) => t * t * (3 - 2 * t);
    static double Lerp(double a, double b, double t) => a + (b - a) * t;

    /// <summary>Valor aleatório estável de um ponto da grelha (mistura de bits de x, y e da semente).</summary>
    public static double Lattice(int x, int y, int seed)
    {
        unchecked
        {
            uint h = (uint)(x * 374761393 + y * 668265263 + seed * 1274126177);
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xFFFFFF) / (double)0x1000000;
        }
    }
}
