using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>Um percurso com o comprimento de cada troço e o total (m), medidos uma vez.</summary>
public sealed class RoutePath
{
    public Coordinate[] Coordinates { get; }
    public double[] Legs { get; }
    public double TotalM { get; }

    RoutePath(Coordinate[] coordinates, double[] legs) { Coordinates = coordinates; Legs = legs; TotalM = legs.Sum(); }

    /// <summary>Nulo quando não há percurso (ou tem menos de dois pontos): a posição é então a do alvo.</summary>
    public static RoutePath? Of(LineString? route)
    {
        if (route is null || route.NumPoints < 2) return null;
        var c = route.Coordinates;
        var legs = new double[c.Length - 1];
        for (int i = 1; i < c.Length; i++) legs[i - 1] = RoadGeometry.DistanceM(c[i - 1].Y, c[i - 1].X, c[i].Y, c[i].X);
        return new RoutePath(c, legs);
    }
}
