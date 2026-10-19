using FireTrace.Core.Models.Fire;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

public class WaterInfluenceTests
{
    [Fact]
    public void Distance_grows_away_from_the_water_and_is_in_metres()
    {
        const int w = 21, h = 5;
        var isWater = new bool[w * h];
        for (int y = 0; y < h; y++) isWater[y * w] = true;
        var d = WaterInfluence.DistanceM(isWater, w, h, 60);
        Assert.Equal(0, d[2 * w]);
        Assert.Equal(60 * 10, d[2 * w + 10], 1);
        Assert.True(d[2 * w + 11] > d[2 * w + 10]);
        Assert.All(WaterInfluence.DistanceM(new bool[w * h], w, h, 60), v => Assert.Equal(float.MaxValue, v));
    }

    [Fact]
    public void The_riparian_factor_slows_near_water_and_fades_with_distance()
    {
        var s = TestSettings.All.Landscape.Riparian;
        float near = WaterInfluence.RiparianFactor(0, s), mid = WaterInfluence.RiparianFactor(80, s), far = WaterInfluence.RiparianFactor((float)s.MaxDistanceM, s);
        Assert.Equal(1 - s.Slowdown, near, 3);
        Assert.InRange(mid, near, 1f);
        Assert.Equal(1f, far);
    }

    [Fact]
    public void Vegetation_next_to_a_lake_burns_slower_than_the_same_vegetation_far_away()
    {
        const int n = 40;
        var spec = new GridSpec(41.4, -8.3, n, n, 60);
        var land = Enumerable.Repeat(LandCover.Eucalipto, n * n).ToArray();
        for (int y = 0; y < n; y++) land[y * n] = LandCover.Agua;
        var adj = TestSettings.FlatLandscape.Adjustment(new TerrainGrids(spec, new float[n * n], land, new ushort[n * n]), Array.Empty<Firebreak>(), Array.Empty<Waterway>());
        Assert.True(adj[20 * n + 2] < adj[20 * n + 30]);
        Assert.Equal(adj[20 * n + 30], adj[20 * n + 38], 4);
    }
}
