namespace FireTrace.ExternalData.Sources.Water;

/// <summary>Geometria plana de um polígono fechado (primeiro ponto repetido no fim), em metros.</summary>
public static class LocalPolygon
{
    public static double Area(IReadOnlyList<(double X, double Y)> ring) => Math.Abs(Cross(ring).Twice) / 2;

    public static (double X, double Y) Centroid(IReadOnlyList<(double X, double Y)> ring)
    {
        var (a2, cx, cy) = Cross(ring);
        return (cx / (3 * a2), cy / (3 * a2));
    }

    /// <summary>Teste do raio: o ponto está dentro do polígono?</summary>
    public static bool Contains(IReadOnlyList<(double X, double Y)> ring, double x, double y)
    {
        bool inside = false;
        for (int i = 0, j = ring.Count - 1; i < ring.Count; j = i++)
        {
            var (xi, yi) = ring[i]; var (xj, yj) = ring[j];
            if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    static (double Twice, double Cx, double Cy) Cross(IReadOnlyList<(double X, double Y)> ring)
    {
        double a2 = 0, cx = 0, cy = 0;
        for (int i = 0; i < ring.Count - 1; i++)
        {
            double cr = ring[i].X * ring[i + 1].Y - ring[i + 1].X * ring[i].Y;
            a2 += cr; cx += (ring[i].X + ring[i + 1].X) * cr; cy += (ring[i].Y + ring[i + 1].Y) * cr;
        }
        return (a2, cx, cy);
    }
}
