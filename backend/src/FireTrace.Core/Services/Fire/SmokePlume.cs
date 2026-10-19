using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Models.Fire;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Fire;

/// <summary>
/// O fumo de um incêndio. A frente emite partículas em proporção à intensidade (combustível queimado × fator de emissão); a coluna sobe à altura que a
/// intensidade dá e o vento leva-a; a nuvem alarga-se (Briggs, conforme a estabilidade da atmosfera) e, chegando ao solo, tira visibilidade.
/// Cada nuvem é uma função pura do tempo, por isso qualquer instante calcula-se sem simular a história.
/// </summary>
public sealed class SmokePlume(SmokeSettings smoke)
{
    SmokeDispersionSettings D => smoke.Dispersion;

    // ------------------------------------------------------------------------------------------------ emissão
    /// <summary>As nuvens que existem ao minuto `tMin`: as emitidas nos últimos `PuffLifetimeMinutes`, de `PuffStepMinutes` em `PuffStepMinutes`, já levadas pelo vento.</summary>
    public IReadOnlyList<SmokePuff> Puffs(FireRun run, int[] burnMinutes, WindDisplacement wind, int tMin)
    {
        var puffs = new List<SmokePuff>();
        var (width, cellM, block) = (run.Spec.Width, run.Spec.CellM, smoke.BlockCells);
        for (int m = tMin; m >= Math.Max(0, tMin - D.PuffLifetimeMinutes); m -= D.PuffStepMinutes)
        {
            var sources = new Dictionary<(int, int), (double Q, double MaxI, bool Crown, double X, double Y, int N)>();
            for (int c = 0; c < run.Ignition.Length; c++)
            {
                int t0 = run.Ignition[c];
                if (t0 < 0 || t0 > m || m >= t0 + Math.Min(burnMinutes[c], D.FlameMinutes)) continue; // só a frente em chamas emite
                int x = c % width, y = c / width; var key = (x / block, y / block);
                double intensity = run.IntensityKwm[c], q = intensity * cellM / D.HeatOfCombustionKjKg * D.EmissionFactorGPerKg; // g/s
                var s = sources.GetValueOrDefault(key);
                sources[key] = (s.Q + q, Math.Max(s.MaxI, intensity), s.Crown || (run.Flags[c] & 1) != 0, s.X + (x + 0.5) * cellM, s.Y + (y + 0.5) * cellM, s.N + 1);
            }
            foreach (var s in sources.Values)
            {
                double mass = s.Q * 60 * D.PuffStepMinutes, height = PlumeHeightM(s.MaxI, s.Crown);
                var (dE, dN) = wind.Between(m, tMin);
                double age = tMin - m, spacing = wind.SpeedMs(m) * 60 * D.PuffStepMinutes;
                puffs.Add(Place(s.X / s.N, s.Y / s.N, mass * (1 - D.LowLevelFraction), height, dE * D.AloftWindFactor, dN * D.AloftWindFactor, age, spacing * D.AloftWindFactor));
                puffs.Add(Place(s.X / s.N, s.Y / s.N, mass * D.LowLevelFraction, 0, dE, dN, age, spacing)); // o fumo de superfície fica junto ao chão
            }
        }
        return puffs;
    }

    static SmokePuff Place(double x, double y, double mass, double height, double east, double north, double age, double spacing) =>
        new(x + east, y - north, mass, height, double.Hypot(east, north), age, spacing); // a linha 0 é o norte

    /// <summary>Altura da coluna (m) a partir da intensidade da frente, com o fogo de copas a subir mais.</summary>
    public double PlumeHeightM(double intensityKwm, bool crown) =>
        (smoke.PlumeBaseHeightM + smoke.PlumeHeightPerSqrtKwm * Math.Sqrt(Math.Max(intensityKwm, 0) / smoke.PlumeReferenceKwm)) * (crown ? smoke.CrownHeightFactor : 1);

    // ------------------------------------------------------------------------------------------------ atmosfera
    /// <summary>A classe de estabilidade ao minuto `tMin`: hora solar do local (longitude), vento e se é dia.</summary>
    public string Stability(FireRun run, double windMs, int tMin)
    {
        var s = D.Stability;
        double solarHour = ((run.Start.UtcDateTime.AddMinutes(tMin).TimeOfDay.TotalHours + run.Spec.ToLatLon(run.Spec.Width / 2.0, run.Spec.Height / 2.0).Lon / 15) % 24 + 24) % 24;
        if (solarHour >= s.DayStartHour && solarHour < s.DayEndHour) return windMs < s.UnstableBelowMs ? "unstable" : windMs < s.SlightlyUnstableBelowMs ? "slightly_unstable" : "neutral";
        return windMs < s.NightStableBelowMs ? "stable" : "neutral";
    }

    public double MixingHeightM(string stability) => stability == "stable" ? D.MixingHeightNightM : D.MixingHeightDayM;

    // ------------------------------------------------------------------------------------------------ concentração
    /// <summary>Partículas (µg/m³) ao nível do solo no ponto (x, y) em metros da grelha, somando todas as nuvens.</summary>
    public double GroundConcentration(IReadOnlyList<SmokePuff> puffs, string stability, double x, double y)
    {
        double total = 0, mixing = MixingHeightM(stability);
        var briggs = D.Briggs[stability];
        foreach (var p in puffs)
        {
            var (sy, sz) = Sigmas(p, briggs);
            double dx = x - p.X, dy = y - p.Y, r2 = dx * dx + dy * dy;
            if (r2 <= Square(ReachSigmas * sy)) total += Amplitude(p, sy, sz, mixing) * Math.Exp(-r2 / (2 * sy * sy));
        }
        return total * 1e6;
    }

    /// <summary>As partículas (µg/m³) ao nível do solo numa grelha de blocos de `blockM` metros (linha 0 = norte), somando todas as nuvens.</summary>
    public double[] Field(IReadOnlyList<SmokePuff> puffs, string stability, int cols, int rows, double blockM)
    {
        var field = new double[cols * rows]; double mixing = MixingHeightM(stability); var briggs = D.Briggs[stability];
        foreach (var p in puffs)
        {
            var (sy, sz) = Sigmas(p, briggs);
            double amplitude = Amplitude(p, sy, sz, mixing), reach = ReachSigmas * sy;
            if (amplitude <= 0) continue; // nuvem ainda no ar: não chega ao solo
            int x0 = Math.Max(0, (int)((p.X - reach) / blockM)), x1 = Math.Min(cols - 1, (int)((p.X + reach) / blockM));
            int y0 = Math.Max(0, (int)((p.Y - reach) / blockM)), y1 = Math.Min(rows - 1, (int)((p.Y + reach) / blockM));
            for (int cy = y0; cy <= y1; cy++)
                for (int cx = x0; cx <= x1; cx++)
                {
                    double dx = (cx + 0.5) * blockM - p.X, dy = (cy + 0.5) * blockM - p.Y, r2 = dx * dx + dy * dy;
                    if (r2 <= reach * reach) field[cy * cols + cx] += amplitude * Math.Exp(-r2 / (2 * sy * sy));
                }
        }
        for (int i = 0; i < field.Length; i++) field[i] *= 1e6;
        return field;
    }

    /// <summary>Quantos σ horizontais contam: para lá disto uma nuvem não pesa.</summary>
    const double ReachSigmas = 3.5;

    static double Square(double v) => v * v;

    /// <summary>
    /// g/m³ no centro de uma nuvem ao nível do solo: gaussiana com reflexão no solo; com σz perto da camada de mistura o fumo reparte-se por toda ela.
    /// É 0 se a nuvem ainda vai tão alta que quase nada chega ao chão.
    /// </summary>
    double Amplitude(SmokePuff p, double sy, double sz, double mixingHeightM)
    {
        if (sz >= D.MixedLayerSigmaRatio * mixingHeightM) return p.MassG / (2 * Math.PI * sy * sy * mixingHeightM);
        double vertical = 2 * Math.Exp(-p.HeightM * p.HeightM / (2 * sz * sz));
        return vertical < 1e-9 ? 0 : p.MassG / (Math.Pow(2 * Math.PI, 1.5) * sy * sy * sz) * vertical;
    }

    /// <summary>σy e σz (m) de uma nuvem: a dispersão de Briggs na distância percorrida mais o tamanho da fonte.</summary>
    public (double Sy, double Sz) Sigmas(SmokePuff p, BriggsClass b)
    {
        double x = Math.Max(p.PathM + D.CalmDiffusionMs * p.AgeMinutes * 60, 1);
        double sy = b.AY * x / Math.Sqrt(1 + b.BY * x), sz = b.AZ * x * Math.Pow(1 + b.BZ * x, b.EZ);
        double sy0 = Math.Max(D.SourceSigmaM, p.SpacingM / 2), sz0 = D.SourceSigmaM * D.SourceSigmaZRatio;
        return (Math.Sqrt(sy * sy + sy0 * sy0), Math.Sqrt(sz * sz + sz0 * sz0));
    }

    // ------------------------------------------------------------------------------------------------ visibilidade
    /// <summary>Visibilidade (m) pela lei de Koschmieder: 3,912 / (extinção mássica · concentração), no máximo `ClearVisibilityM`.</summary>
    public SmokeVisibility Visibility(double concentrationUgm3)
    {
        double extinction = D.MassExtinctionM2g * concentrationUgm3 * 1e-6; // 1/m
        double visibility = extinction <= 0 ? D.ClearVisibilityM : Math.Min(D.ClearVisibilityM, 3.912 / extinction);
        return new(concentrationUgm3, visibility, D.VisibilityClassesM.Count(limit => visibility <= limit));
    }
}
