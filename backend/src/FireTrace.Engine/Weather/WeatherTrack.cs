namespace FireTrace.Engine.Weather;

/// <summary>
/// A meteorologia contínua de uma simulação: interpola entre os pontos (o vento por vetores, para o rumo rodar pelo caminho certo).
/// Os membros do ensemble são cópias com o vento, o rumo e a humidade do combustível perturbados.
/// </summary>
public sealed class WeatherTrack
{
    readonly WeatherPoint[] _points;

    public double WindScale { get; init; } = 1;
    public double DirOffsetDeg { get; init; }
    /// <summary>Multiplica a humidade do combustível morto (&gt;1 = mais húmido, fogo mais lento).</summary>
    public double MoistScale { get; init; } = 1;

    public WeatherTrack(IEnumerable<WeatherPoint> points)
    {
        _points = points.OrderBy(p => p.Minute).ToArray();
        if (_points.Length == 0) throw new ArgumentException("Série meteorológica vazia", nameof(points));
    }

    public IReadOnlyList<WeatherPoint> Points => _points;

    public static WeatherTrack Constant(double windKmh, double windFromDeg, double humidityPct, double tempC = 25) =>
        new(new[] { new WeatherPoint(0, windKmh, windFromDeg, humidityPct, tempC) });

    public WeatherTrack Perturbed(double windScale, double dirOffsetDeg, double moistScale) =>
        new(_points) { WindScale = windScale, DirOffsetDeg = dirOffsetDeg, MoistScale = moistScale };

    public WeatherPoint At(double minute)
    {
        int hi = Array.FindIndex(_points, p => p.Minute >= minute);
        WeatherPoint r;
        if (hi < 0) r = _points[^1];
        else if (hi == 0 || _points[hi].Minute == minute) r = _points[hi];
        else
        {
            var a = _points[hi - 1]; var b = _points[hi];
            double f = (minute - a.Minute) / (b.Minute - a.Minute);
            var nearest = f < 0.5 ? a : b;
            var (ax, ay) = Vector(a); var (bx, by) = Vector(b);
            double vx = ax + (bx - ax) * f, vy = ay + (by - ay) * f;
            r = new WeatherPoint(minute, a.WindKmh + (b.WindKmh - a.WindKmh) * f, double.Hypot(vx, vy) < 0.1 ? a.WindFromDeg : Angles.Normalize(Math.Atan2(vx, vy) * 180 / Math.PI),
                a.HumidityPct + (b.HumidityPct - a.HumidityPct) * f, a.TempC + (b.TempC - a.TempC) * f, a.GustKmh + (b.GustKmh - a.GustKmh) * f,
                a.PrecipitationMmH + (b.PrecipitationMmH - a.PrecipitationMmH) * f, a.CloudCoverPct + (b.CloudCoverPct - a.CloudCoverPct) * f,
                a.SolarRadiationWm2 + (b.SolarRadiationWm2 - a.SolarRadiationWm2) * f,
                nearest.VisibilityM, nearest.CapeJkg, nearest.IsDay);
        }
        return r with { Minute = minute, WindKmh = Math.Max(0, r.WindKmh * WindScale), GustKmh = Math.Max(0, r.GustKmh * WindScale), WindFromDeg = Angles.Normalize(r.WindFromDeg + DirOffsetDeg) };
    }

    static (double X, double Y) Vector(WeatherPoint p) => (Math.Sin(p.WindFromDeg * Math.PI / 180) * p.WindKmh, Math.Cos(p.WindFromDeg * Math.PI / 180) * p.WindKmh);
}
