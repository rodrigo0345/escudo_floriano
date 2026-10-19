namespace FireTrace.ExternalData.Map;

/// <summary>Procura do troço mais próximo de um ponto, com as caixas dos troços calculadas uma vez.</summary>
public sealed class RoadIndex
{
    readonly RoadNetwork _net;
    readonly (double X0, double Y0, double X1, double Y1)[] _boxes;

    public RoadIndex(RoadNetwork net)
    {
        _net = net;
        _boxes = net.Edges.Select(e =>
        {
            double x0 = double.MaxValue, y0 = double.MaxValue, x1 = double.MinValue, y1 = double.MinValue;
            for (int i = 0; i < e.Pts.Length; i += 2) { x0 = Math.Min(x0, e.Pts[i]); x1 = Math.Max(x1, e.Pts[i]); y0 = Math.Min(y0, e.Pts[i + 1]); y1 = Math.Max(y1, e.Pts[i + 1]); }
            return (x0, y0, x1, y1);
        }).ToArray();
    }

    /// <summary>O troço mais próximo (e a distância em metros) dentro de `maxM` metros; nada se não houver.</summary>
    public (RoadEdge Edge, double DistanceM)? Nearest(double lat, double lon, double maxM = 150, Func<RoadEdge, bool>? accept = null)
    {
        var (x, y) = _net.Spec.ToCell(lat, lon);
        double reach = maxM / _net.Spec.CellM, best = double.MaxValue;
        RoadEdge? bestEdge = null;
        for (int ei = 0; ei < _net.Edges.Count; ei++)
        {
            var (x0, y0, x1, y1) = _boxes[ei];
            if (x < x0 - reach || x > x1 + reach || y < y0 - reach || y > y1 + reach) continue;
            var edge = _net.Edges[ei];
            if (accept is not null && !accept(edge)) continue;
            for (int i = 0; i + 3 < edge.Pts.Length; i += 2)
            {
                double d = SegmentDistance(x, y, edge.Pts[i], edge.Pts[i + 1], edge.Pts[i + 2], edge.Pts[i + 3]);
                if (d < best) { best = d; bestEdge = edge; }
            }
        }
        return bestEdge is not null && best * _net.Spec.CellM <= maxM ? (bestEdge, best * _net.Spec.CellM) : null;
    }

    static double SegmentDistance(double px, double py, double ax, double ay, double bx, double by)
    {
        double dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        double t = l2 == 0 ? 0 : Math.Clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
        double qx = ax + t * dx - px, qy = ay + t * dy - py;
        return Math.Sqrt(qx * qx + qy * qy);
    }
}
