using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Coupling;

/// <summary>
/// O vento que o próprio fogo cria. A coluna de convecção sobe e o ar à volta é puxado para o fogo, com velocidade de flutuabilidade
/// U = (g·I / (ρ·cp·T))^(1/3), onde I é a intensidade da frente (W/m). O efeito decai com a distância e soma-se ao vento ambiente: à frente do fogo
/// abranda o vento que o empurra, nos flancos estreita-o, atrás reforça o que o acompanha. Calcula-se por blocos de terreno (o motor lê o vento a essa escala).
/// </summary>
public static class ConvectiveWind
{
    /// <summary>Número de blocos por lado que cobrem a grelha (o mesmo cálculo do motor, para as grelhas coincidirem).</summary>
    public static (int Cols, int Rows) Blocks(EngineGrid spec, double blockM) =>
        (Math.Max(2, (int)Math.Ceiling(spec.Width * spec.CellM / blockM)), Math.Max(2, (int)Math.Ceiling(spec.Height * spec.CellM / blockM)));

    /// <summary>Velocidade (m/s) do ar puxado por uma frente de intensidade `intensityKwm`.</summary>
    public static double InflowSpeed(double intensityKwm, ConvectionSettings s) =>
        s.InflowEfficiency * Math.Cbrt(s.GravityMs2 * intensityKwm * 1000 / s.HeatCapacityJm3);

    /// <summary>O vento por bloco e por intervalo meteorológico (`bands` intervalos de `dtMetSeconds`), dado onde e com que intensidade o fogo já ardeu.</summary>
    public static WindField Field(EngineGrid spec, FireResult fire, WeatherTrack ambient, int bands, int dtMetSeconds, ConvectionSettings s)
    {
        var (cols, rows) = Blocks(spec, s.BlockM);
        int blockCount = cols * rows;
        var speed = new float[bands * blockCount]; var from = new float[bands * blockCount];
        var burning = Enumerable.Range(0, fire.Ignition.Length).Where(c => fire.Ignition[c] >= 0 && fire.IntensityKwm[c] >= s.MinIntensityKwm).OrderBy(c => fire.Ignition[c]).ToArray();
        int first = 0, last = 0, stepMinutes = dtMetSeconds / 60;

        for (int k = 0; k < bands; k++)
        {
            int minute = k * stepMinutes;
            while (last < burning.Length && fire.Ignition[burning[last]] <= minute) last++;
            while (first < last && fire.Ignition[burning[first]] < minute - s.ActiveWindowMinutes) first++;
            Band(spec, fire, burning.AsSpan(first, last - first), ambient, minute, s, speed.AsSpan(k * blockCount, blockCount), from.AsSpan(k * blockCount, blockCount));
        }
        return new WindField(cols, rows, s.BlockM, speed, from);
    }

    /// <summary>Um intervalo: o vento ambiente mais o ar que o fogo em chamas (`burning`) puxa para si, bloco a bloco.</summary>
    static void Band(EngineGrid spec, FireResult fire, ReadOnlySpan<int> burning, WeatherTrack ambient, int minute, ConvectionSettings s, Span<float> speed, Span<float> from)
    {
        var (cols, rows) = Blocks(spec, s.BlockM);
        int blockCount = cols * rows, reach = (int)Math.Ceiling(s.InflowRangeFactor * s.InflowDecayM / s.BlockM);
        var intensitySum = new double[blockCount]; var active = new int[blockCount];
        foreach (int c in burning)
        {
            int b = BlockOf(c % spec.Width, c / spec.Width, spec, s.BlockM, cols, rows);
            intensitySum[b] += fire.IntensityKwm[c]; active[b]++;
        }
        var (east, north) = Induced(intensitySum, active, spec, cols, rows, reach, s);

        var w = ambient.At(minute);
        double fromX = Math.Sin(w.WindFromDeg * Math.PI / 180) * w.WindKmh, fromY = Math.Cos(w.WindFromDeg * Math.PI / 180) * w.WindKmh;
        for (int b = 0; b < blockCount; b++)
        {
            double ux = east[b] * 3.6, uy = north[b] * 3.6, mag = double.Hypot(ux, uy);
            double cap = Math.Min(s.MaxInducedKmh, Math.Max(s.MinInducedCapKmh, s.MaxInducedFraction * w.WindKmh));
            if (mag > cap) { ux *= cap / mag; uy *= cap / mag; }
            double fx = fromX - ux, fy = fromY - uy, total = double.Hypot(fx, fy);
            speed[b] = (float)total;
            from[b] = (float)(total < 0.1 ? w.WindFromDeg : Angles.Normalize(Math.Atan2(fx, fy) * 180 / Math.PI));
        }
    }

    static int BlockOf(int x, int y, EngineGrid spec, double blockM, int cols, int rows) =>
        Math.Min(rows - 1, (int)(y * spec.CellM / blockM)) * cols + Math.Min(cols - 1, (int)(x * spec.CellM / blockM));

    /// <summary>A soma, em cada bloco, do ar puxado por cada bloco em chamas à volta (m/s, leste e norte), com a intensidade média e a fração da frente que arde.</summary>
    static (double[] East, double[] North) Induced(double[] intensitySum, int[] active, EngineGrid spec, int cols, int rows, int reach, ConvectionSettings s)
    {
        var east = new double[cols * rows]; var north = new double[cols * rows];
        double cellsPerBlockSide = s.BlockM / spec.CellM;
        for (int src = 0; src < intensitySum.Length; src++)
        {
            if (active[src] == 0) continue;
            double strength = InflowSpeed(intensitySum[src] / active[src], s) * Math.Min(1, active[src] / cellsPerBlockSide);
            int sx = src % cols, sy = src / cols;
            for (int ty = Math.Max(0, sy - reach); ty <= Math.Min(rows - 1, sy + reach); ty++)
                for (int tx = Math.Max(0, sx - reach); tx <= Math.Min(cols - 1, sx + reach); tx++)
                {
                    double dEast = (sx - tx) * s.BlockM, dNorth = (ty - sy) * s.BlockM, d = double.Hypot(dEast, dNorth); // linha 0 = norte
                    if (d == 0 || d > s.InflowRangeFactor * s.InflowDecayM) continue;
                    double pull = strength * Math.Exp(-d / s.InflowDecayM);
                    east[ty * cols + tx] += pull * dEast / d; north[ty * cols + tx] += pull * dNorth / d;
                }
        }
        return (east, north);
    }
}
