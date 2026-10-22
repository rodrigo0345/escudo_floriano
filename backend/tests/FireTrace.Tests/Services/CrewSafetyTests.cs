using FireTrace.Core.Services.Operations;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

public class CrewSafetyTests
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
    static readonly LatLon Site = new(41.0, -8.0);

    [Fact]
    public void A_crew_moves_along_its_route_and_stays_at_the_site_after_arriving()
    {
        var route = Gf.CreateLineString(new[] { new Coordinate(-8.2, 41.0), new Coordinate(-8.1, 41.0), new Coordinate(-8.0, 41.0) });
        Assert.Equal(-8.2, CrewSafety.PositionAt(route, 20, Site, 0).Lon, 4);
        Assert.Equal(-8.1, CrewSafety.PositionAt(route, 20, Site, 10).Lon, 3);          // a meio do tempo, a meio do caminho
        Assert.Equal(Site, CrewSafety.PositionAt(route, 20, Site, 20));                  // chegou
        Assert.Equal(Site, CrewSafety.PositionAt(route, 20, Site, 45));                  // e fica lá
    }

    [Fact]
    public void Without_a_route_the_crew_is_at_the_site()
    {
        Assert.Equal(Site, CrewSafety.PositionAt(null, 20, Site, 5));
    }

    /// <summary>A versão antiga, que media o percurso a cada chamada, copiada tal e qual: o oráculo de que medi-lo uma só vez dá exatamente a mesma posição.</summary>
    static LatLon ReferencePositionAt(LineString? route, double eta, LatLon site, double minute)
    {
        if (route is null || route.NumPoints < 2 || eta <= 0 || minute >= eta) return site;
        var c = route.Coordinates;
        var legs = new double[c.Length - 1];
        for (int i = 1; i < c.Length; i++) legs[i - 1] = RoadGeometry.DistanceM(c[i - 1].Y, c[i - 1].X, c[i].Y, c[i].X);
        double target = Math.Max(0, minute) / eta * legs.Sum();
        for (int i = 0; i < legs.Length; i++)
        {
            if (target <= legs[i] || i == legs.Length - 1)
            {
                double f = legs[i] <= 0 ? 0 : Math.Min(1, target / legs[i]);
                return new LatLon(c[i].Y + (c[i + 1].Y - c[i].Y) * f, c[i].X + (c[i + 1].X - c[i].X) * f);
            }
            target -= legs[i];
        }
        return site;
    }

    [Fact]
    public void Measuring_the_route_once_gives_exactly_the_old_position_at_every_minute()
    {
        var random = new Random(20261022);
        for (int trial = 0; trial < 200; trial++)
        {
            int points = random.Next(0, 40); // 0 e 1 pontos: sem percurso
            var coordinates = Enumerable.Range(0, points).Select(_ => new Coordinate(-8.3 + random.NextDouble() * 0.2, 41.3 + random.NextDouble() * 0.2)).ToList();
            if (points > 3 && trial % 5 == 0) coordinates[2] = coordinates[1].Copy(); // um troço de comprimento zero
            var route = points >= 2 ? Gf.CreateLineString(coordinates.ToArray()) : null;
            double eta = trial % 7 == 0 ? 0 : 1 + random.NextDouble() * 90;
            var path = RoutePath.Of(route);
            for (double minute = -5; minute <= eta + 10; minute += 0.75)
            {
                var expected = ReferencePositionAt(route, eta, Site, minute);
                Assert.Equal(expected, CrewSafety.PositionOn(path, eta, Site, minute)); // LatLon é um record: igualdade exata, bit a bit
                Assert.Equal(expected, CrewSafety.PositionAt(route, eta, Site, minute));
            }
        }
    }
}
