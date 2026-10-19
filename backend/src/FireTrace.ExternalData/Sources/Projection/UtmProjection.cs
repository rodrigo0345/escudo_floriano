namespace FireTrace.ExternalData.Sources.Projection;

/// <summary>Projeção UTM (WGS84, hemisfério norte), fórmulas de Snyder.</summary>
public static class UtmProjection
{
    public static (double X, double Y) Project(double latDeg, double lonDeg, int zone)
    {
        const double a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
        double e2 = f * (2 - f), ep2 = e2 / (1 - e2);
        double lat = latDeg * Math.PI / 180, lon0 = (zone * 6 - 183) * Math.PI / 180, lon = lonDeg * Math.PI / 180;
        double N = a / Math.Sqrt(1 - e2 * Math.Sin(lat) * Math.Sin(lat)), T = Math.Tan(lat) * Math.Tan(lat), C = ep2 * Math.Cos(lat) * Math.Cos(lat), A = (lon - lon0) * Math.Cos(lat);
        double M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * lat - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.Sin(2 * lat)
                        + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.Sin(4 * lat) - 35 * e2 * e2 * e2 / 3072 * Math.Sin(6 * lat));
        double x = k0 * N * (A + (1 - T + C) * Math.Pow(A, 3) / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.Pow(A, 5) / 120) + 500000;
        double y = k0 * (M + N * Math.Tan(lat) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * Math.Pow(A, 4) / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.Pow(A, 6) / 720));
        return (x, y);
    }
}
