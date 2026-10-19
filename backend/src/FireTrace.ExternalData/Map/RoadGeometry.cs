namespace FireTrace.ExternalData.Map;

public static class RoadGeometry
{
    /// <summary>Células únicas (índices y*W+x) atravessadas pela polilinha, amostrada a cada 0,5 célula.</summary>
    public static int[] CellsOf(double[] pts, GridSpec spec)
    {
        var set = new HashSet<int>();
        void Add(double x, double y)
        {
            int cx = Math.Clamp((int)Math.Round(x), 0, spec.Width - 1), cy = Math.Clamp((int)Math.Round(y), 0, spec.Height - 1);
            set.Add(cy * spec.Width + cx);
        }
        Add(pts[0], pts[1]);
        for (int i = 2; i < pts.Length; i += 2)
        {
            double x0 = pts[i - 2], y0 = pts[i - 1], x1 = pts[i], y1 = pts[i + 1];
            int k = Math.Max((int)Math.Ceiling(double.Hypot(x1 - x0, y1 - y0) / 0.5), 1);
            for (int j = 1; j <= k; j++) Add(x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k);
        }
        return set.ToArray();
    }

    public static double Length(double[] pts)
    {
        double l = 0;
        for (int i = 2; i < pts.Length; i += 2) l += double.Hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
        return l;
    }

    /// <summary>Distância em metros em linha reta entre dois pontos (haversine).</summary>
    public static double DistanceM(double lat1, double lon1, double lat2, double lon2)
    {
        double k = Math.PI / 180, dLat = (lat2 - lat1) * k, dLon = (lon2 - lon1) * k;
        double a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) + Math.Cos(lat1 * k) * Math.Cos(lat2 * k) * Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        return 6371000 * 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));
    }
}
