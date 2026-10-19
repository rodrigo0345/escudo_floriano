using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Fire;

/// <summary>Traduz geometrias WGS84 em células da grelha.</summary>
public static class Zones
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);

    /// <summary>Metros por grau de latitude (esfera média): chega para alargar zonas de algumas centenas de metros.</summary>
    public const double MetersPerDegree = 111320.0;

    /// <summary>Células tocadas pela geometria, alargada `radiusM` metros (linhas amostradas a cada meia célula; áreas por centro de célula).</summary>
    public static IEnumerable<int> CellsOf(GridSpec spec, Geometry g, double radiusM)
    {
        var result = new HashSet<int>();
        if (radiusM <= 0 && g is not Polygon and not MultiPolygon)
        {
            foreach (var line in Lines(g))
            {
                var pts = line.Coordinates.SelectMany(c => { var (x, y) = spec.ToCell(c.Y, c.X); return new[] { x, y }; }).ToArray();
                if (pts.Length >= 4) foreach (var c in RoadGeometry.CellsOf(pts, spec)) result.Add(c);
            }
            foreach (var p in Points(g)) { var c = spec.CellAt(p.Y, p.X); if (c >= 0) result.Add(c); }
            return result;
        }
        double radiusDeg = radiusM / MetersPerDegree;
        var zone = radiusM > 0 ? g.Buffer(radiusDeg) : g;
        var prepared = NetTopologySuite.Geometries.Prepared.PreparedGeometryFactory.Prepare(zone);
        var env = zone.EnvelopeInternal;
        var (x0, y1) = spec.ToCell(env.MinY, env.MinX); var (x1, y0) = spec.ToCell(env.MaxY, env.MaxX);
        for (int y = Math.Max(0, (int)Math.Floor(y0)); y <= Math.Min(spec.Height - 1, (int)Math.Ceiling(y1)); y++)
            for (int x = Math.Max(0, (int)Math.Floor(x0)); x <= Math.Min(spec.Width - 1, (int)Math.Ceiling(x1)); x++)
            {
                var (lat, lon) = spec.ToLatLon(x, y);
                if (prepared.Contains(Gf.CreatePoint(new Coordinate(lon, lat)))) result.Add(y * spec.Width + x);
            }
        return result;
    }

    /// <summary>
    /// Torna uma linha de células 4-conexa: onde a linha passa na diagonal acrescenta-se uma célula do lado, senão o fogo atravessava pelo canto
    /// (uma barreira só trava de verdade se não tiver frestas).
    /// </summary>
    public static IEnumerable<int> Connected(IEnumerable<int> cells, int width)
    {
        var set = cells.ToHashSet();
        foreach (int c in set.ToArray())
        {
            int x = c % width, y = c / width;
            foreach (var (dx, dy) in new[] { (1, 1), (1, -1) })
            {
                int nx = x + dx, ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0) continue;
                if (set.Contains(ny * width + nx) && !set.Contains(y * width + nx) && !set.Contains(ny * width + x)) set.Add(y * width + nx);
            }
        }
        return set;
    }

    static IEnumerable<LineString> Lines(Geometry g) => Enumerable.Range(0, g.NumGeometries).Select(g.GetGeometryN).OfType<LineString>();
    static IEnumerable<Coordinate> Points(Geometry g) => Enumerable.Range(0, g.NumGeometries).Select(g.GetGeometryN).OfType<Point>().Select(p => p.Coordinate);
}
