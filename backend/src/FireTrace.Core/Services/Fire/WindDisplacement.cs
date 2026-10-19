using FireTrace.Core.Domain.Fire;

namespace FireTrace.Core.Services.Fire;

/// <summary>O deslocamento acumulado que o vento dá ao fumo por minuto de simulação (m, para leste e para norte) e a sua velocidade.</summary>
public sealed class WindDisplacement
{
    readonly double[] _east, _north, _speedMs;

    public WindDisplacement(FireRun run, int minutes)
    {
        var samples = run.Weather.Select(w => (Minute: (w.Time - run.Start).TotalMinutes, Kmh: w.WindKmh ?? 0, From: (w.WindFromDeg ?? 0) * Math.PI / 180)).OrderBy(s => s.Minute).ToArray();
        _east = new double[minutes + 1]; _north = new double[minutes + 1]; _speedMs = new double[minutes + 1];
        for (int m = 0; m <= minutes; m++)
        {
            var (kmh, from) = At(samples, m);
            double ms = kmh / 3.6;
            _speedMs[m] = ms;
            if (m == 0) continue;
            _east[m] = _east[m - 1] - Math.Sin(from) * ms * 60; _north[m] = _north[m - 1] - Math.Cos(from) * ms * 60; // o fumo vai para onde o vento sopra (oposto ao rumo de onde vem)
        }
    }

    /// <summary>O vento (km/h, rumo de onde sopra) a este minuto: interpola o vetor entre amostras e mantém as pontas.</summary>
    static (double Kmh, double From) At((double Minute, double Kmh, double From)[] s, double minute)
    {
        if (s.Length == 0) return (0, 0);
        int hi = Array.FindIndex(s, x => x.Minute >= minute);
        if (hi < 0) return (s[^1].Kmh, s[^1].From);
        if (hi == 0) return (s[0].Kmh, s[0].From);
        var (a, b) = (s[hi - 1], s[hi]);
        double f = (minute - a.Minute) / (b.Minute - a.Minute), vx = Lerp(Math.Sin(a.From) * a.Kmh, Math.Sin(b.From) * b.Kmh, f), vy = Lerp(Math.Cos(a.From) * a.Kmh, Math.Cos(b.From) * b.Kmh, f);
        return (double.Hypot(vx, vy), double.Hypot(vx, vy) < 0.1 ? a.From : Math.Atan2(vx, vy));
    }

    static double Lerp(double a, double b, double f) => a + (b - a) * f;

    int Clamp(double minute) => (int)Math.Clamp(Math.Round(minute), 0, _east.Length - 1);

    /// <summary>Deslocamento (leste, norte) em metros entre dois minutos.</summary>
    public (double East, double North) Between(double from, double to) => (_east[Clamp(to)] - _east[Clamp(from)], _north[Clamp(to)] - _north[Clamp(from)]);

    public double SpeedMs(double minute) => _speedMs[Clamp(minute)];
}
