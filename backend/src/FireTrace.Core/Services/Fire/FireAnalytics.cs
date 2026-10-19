using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Models.Fire;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;
using NetTopologySuite.Operation.Union;
using NetTopologySuite.Simplify;

namespace FireTrace.Core.Services.Fire;

/// <summary>Funções puras sobre a grelha de minutos de ignição: área, perímetro, direção e velocidade da frente. Não conhecem HTTP nem bases de dados.</summary>
public static class FireAnalytics
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);

    public static double CellHa(GridSpec spec) => spec.CellM * spec.CellM / 1e4;

    public static int BurnedCells(int[] ign, int t) => ign.Count(v => v >= 0 && v <= t);

    public static double AreaHa(int[] ign, GridSpec spec, int t) => BurnedCells(ign, t) * CellHa(spec);

    /// <summary>Vetores de propagação: o gradiente do tempo de ignição dá a direção (para onde o fogo avança) e 1/|∇T| a velocidade.</summary>
    public static List<FireVector> Vectors(int[] ign, GridSpec spec, int t, AnalyticsSettings s, int frontMinutes)
    {
        int block = s.VectorBlockCells;
        int w = spec.Width, h = spec.Height;
        var acc = new Dictionary<(int, int), List<(double Gx, double Gy, double Sp, double X, double Y)>>();
        for (int y = 1; y < h - 1; y++)
            for (int x = 1; x < w - 1; x++)
            {
                int c = ign[y * w + x];
                if (c < 0 || c > t || t - c > frontMinutes) continue;
                double Tn(int xx, int yy, double fallback) { int v = ign[yy * w + xx]; return v < 0 || v > t + frontMinutes ? fallback : v; }
                double gx = (Tn(x + 1, y, c) - Tn(x - 1, y, c)) / 2.0, gy = (Tn(x, y + 1, c) - Tn(x, y - 1, c)) / 2.0;
                double mag = double.Hypot(gx, gy);
                if (mag < s.VectorMinGradient) continue;
                if (!acc.TryGetValue((x / block, y / block), out var l)) acc[(x / block, y / block)] = l = new();
                l.Add((gx / mag, gy / mag, spec.CellM / Math.Max(mag, s.VectorMinSpeedGradient), x, y)); // m/min
            }
        var res = new List<FireVector>();
        foreach (var l in acc.Values.Where(l => l.Count >= s.VectorMinSamplesPerBlock))
        {
            double mx = l.Average(v => v.Gx), my = l.Average(v => v.Gy), cx = l.Average(v => v.X), cy = l.Average(v => v.Y);
            if (double.Hypot(mx, my) < s.VectorMinDirectionConsistency) continue; // direções opostas (ilhas): sem direção clara
            var sp = l.Select(v => v.Sp).OrderBy(v => v).ToArray();
            var (lat, lon) = spec.ToLatLon(cx, cy);
            res.Add(new FireVector(lat, lon, (Math.Atan2(mx, -my) * 180 / Math.PI + 360) % 360, sp[sp.Length / 2]));
        }
        return res;
    }

    /// <summary>A origem do fogo: o centro das células que arderam primeiro.</summary>
    public static LatLon? Origin(int[] ign, GridSpec spec)
    {
        int first = ign.Where(v => v >= 0).DefaultIfEmpty(-1).Min();
        if (first < 0) return null;
        var cells = Enumerable.Range(0, ign.Length).Where(c => ign[c] == first).ToList();
        var (lat, lon) = spec.ToLatLon(cells.Average(c => c % spec.Width), cells.Average(c => c / spec.Width));
        return new LatLon(lat, lon);
    }

    /// <summary>
    /// A cabeça do fogo. Com a origem, é a parte da frente mais afastada dela (o fogo avança para lá, e o rumo é o da origem até lá); sem ela, o quartil mais rápido.
    /// Nos dois casos sem os 10 % extremos (artefactos de focos secundários). A velocidade mais alta de um vetor sozinha engana: nos flancos a frente quase não se
    /// desfasa e o gradiente do tempo de ignição dá velocidades altas para o lado.
    /// </summary>
    public static (double SpeedMPerMin, double BearingDeg, LatLon Position)? Head(IReadOnlyList<FireVector> vectors, AnalyticsSettings s, LatLon? origin = null)
    {
        if (vectors.Count == 0) return null;
        int skip = (int)(vectors.Count * s.HeadTrimFraction), take = Math.Max(1, (int)(vectors.Count * s.HeadFraction));
        double Reach(FireVector v) => origin is { } o ? double.Hypot((v.Lon - o.Lon) * Math.Cos(o.Lat * Math.PI / 180), v.Lat - o.Lat) : v.SpeedMPerMin;
        var head = vectors.OrderByDescending(Reach).Skip(skip).Take(take).ToArray();
        double speed = head.OrderBy(v => v.SpeedMPerMin).ElementAt(head.Length / 2).SpeedMPerMin;
        var position = new LatLon(head.Average(v => v.Lat), head.Average(v => v.Lon));
        double bearing;
        if (origin is { } from) bearing = (Math.Atan2((position.Lon - from.Lon) * Math.Cos(from.Lat * Math.PI / 180), position.Lat - from.Lat) * 180 / Math.PI + 360) % 360;
        else { double sin = head.Sum(v => Math.Sin(v.BearingDeg * Math.PI / 180)), cos = head.Sum(v => Math.Cos(v.BearingDeg * Math.PI / 180)); bearing = (Math.Atan2(sin, cos) * 180 / Math.PI + 360) % 360; }
        return (Math.Round(speed, 1), Math.Round(bearing), position);
    }

    /// <summary>Perímetro (união das células ardidas até t) como multipolígono em WGS84; vazio se ainda nada ardeu.</summary>
    public static Geometry Perimeter(int[] ign, GridSpec spec, int t, AnalyticsSettings s)
    {
        int w = spec.Width, h = spec.Height;
        var squares = new List<Geometry>();
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int c = ign[y * w + x];
                if (c < 0 || c > t) continue;
                squares.Add(Gf.CreatePolygon(new[] { new Coordinate(x - .5, y - .5), new Coordinate(x + .5, y - .5), new Coordinate(x + .5, y + .5), new Coordinate(x - .5, y + .5), new Coordinate(x - .5, y - .5) }));
            }
        if (squares.Count == 0) return Gf.CreateMultiPolygon();
        var union = DouglasPeuckerSimplifier.Simplify(CascadedPolygonUnion.Union(squares), s.PerimeterSimplifyTolerance);
        var polys = new List<Polygon>();
        void Collect(Geometry g) { if (g is Polygon p) polys.Add(p); else if (g is GeometryCollection gc) foreach (var part in gc.Geometries) Collect(part); }
        Collect(union);
        LinearRing Ring(LineString r) => Gf.CreateLinearRing(r.Coordinates.Select(c => { var (lat, lon) = spec.ToLatLon(c.X, c.Y); return new Coordinate(Math.Round(lon, 6), Math.Round(lat, 6)); }).ToArray());
        return Gf.CreateMultiPolygon(polys.Select(p => Gf.CreatePolygon(Ring(p.ExteriorRing), p.InteriorRings.Select(Ring).ToArray())).ToArray());
    }

    /// <summary>Quantiles p10/p50/p90 (por interpolação de ordem) de um conjunto de valores.</summary>
    public static FireTrace.Core.Domain.Common.Quantiles Quantiles(IReadOnlyCollection<double> values)
    {
        if (values.Count == 0) return new(null, null, null);
        var s = values.OrderBy(v => v).ToArray();
        double At(double p) => s[Math.Min(s.Length - 1, (int)Math.Round(p * (s.Length - 1)))];
        return new(Math.Round(At(0.1), 1), Math.Round(At(0.5), 1), Math.Round(At(0.9), 1));
    }
}
