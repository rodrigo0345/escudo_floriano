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
}
