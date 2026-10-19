using FireTrace.Engine.Configuration;

namespace FireTrace.Engine.Weather;

/// <summary>
/// Humidade do combustível morto de 1 h, 10 h e 100 h (%) a partir da meteorologia: equilíbrio de Simard (HR e temperatura) com atraso de
/// primeira ordem por classe de diâmetro. É o que as noites húmidas e as tardes secas fazem ao combustível fino e grosso.
/// </summary>
public static class DeadFuelMoisture
{
    /// <summary>Uma linha por intervalo meteorológico, no formato que o motor lê: vento, rumo, humidades do combustível (%).</summary>
    public sealed record Row(double Ws, double Wd, double M1, double M10, double M100, double Lh, double Lw);

    /// <summary>Humidade de equilíbrio do combustível fino (fração) a partir de HR (%) e temperatura (°C): Simard (1968). Os coeficientes são os do artigo.</summary>
    public static double EquilibriumMoisture(double rh, double tempC, FuelMoistureSettings s)
    {
        double t = tempC * 9 / 5 + 32;
        rh = Math.Clamp(rh, 1, 100);
        double m = rh < 10 ? 0.03229 + 0.281073 * rh - 0.000578 * rh * t
                 : rh < 50 ? 2.22749 + 0.160107 * rh - 0.014784 * t
                 : 21.0606 + 0.005565 * rh * rh - 0.00035 * rh * t - 0.483199 * rh;
        return Math.Clamp(m / 100.0, s.MinEquilibriumMoisture, s.MaxEquilibriumMoisture);
    }

    public static IReadOnlyList<Row> Series(WeatherTrack wx, int dtMetSeconds, int bands, FuelMoistureSettings s, int spinUpMin, FuelMoistureSpec? spec = null)
    {
        var rows = new List<Row>();
        int step = dtMetSeconds / 60;

        if (spec is { Mode: "fixed", Values: { } v })
        {
            for (int k = 0; k < bands; k++)
            {
                var w = wx.At(k * step);
                rows.Add(new Row(w.WindKmh, w.WindFromDeg, v.Dead1hPct ?? s.Dead1hPct, v.Dead10hPct ?? s.Dead10hPct, v.Dead100hPct ?? s.Dead100hPct, v.LiveHerbaceousPct ?? s.LiveHerbaceousPct, v.LiveWoodyPct ?? s.LiveWoodyPct));
            }
            return rows;
        }

        double bias = spec?.DeadBiasPct ?? 0;
        double Eq(int minute) { var w = wx.At(minute); return EquilibriumMoisture(w.HumidityPct, w.TempC, s) * 100 * wx.MoistScale + bias; }
        double mean = Enumerable.Range(-spinUpMin, spinUpMin + 1).Where(m => m % s.EquilibriumSampleMinutes == 0).Average(Eq);
        double m1 = Eq(-spinUpMin), m10 = mean, m100 = mean; // os grossos começam no equilíbrio médio do período anterior
        int minute = -spinUpMin;
        for (int k = 0; k < bands; k++)
        {
            int target = k * step;
            for (; minute < target; minute++)
            {
                double e = Eq(minute);
                m1 += (e - m1) * (1 - Math.Exp(-1 / s.TimeLag1hMinutes)); m10 += (e - m10) * (1 - Math.Exp(-1 / s.TimeLag10hMinutes)); m100 += (e - m100) * (1 - Math.Exp(-1 / s.TimeLag100hMinutes));
            }
            var w = wx.At(target);
            rows.Add(new Row(w.WindKmh, w.WindFromDeg, Math.Max(m1, s.MinDeadMoisturePct), Math.Max(m10, s.MinDeadMoisturePct), Math.Max(m100, s.MinDeadMoisturePct),
                spec?.Values?.LiveHerbaceousPct ?? s.LiveHerbaceousPct, spec?.Values?.LiveWoodyPct ?? s.LiveWoodyPct));
        }
        return rows;
    }
}
