using FireTrace.Core.Models.Fire;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

/// <summary>Estradas e rios como barreiras que o vento forte galga, a água que humedece o combustível à volta e o vento que o próprio fogo cria.</summary>
public class BarrierTests
{
    const int N = 60;
    static readonly GridSpec Spec = new(41.4, -8.3, N, N, 60);
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
    static readonly float Min = (float)TestSettings.All.Landscape.MinAdjustmentFactor;

    static RoadEdge Road(string highway, bool offRoad = false)
    {
        double[] pts = Enumerable.Range(0, N).SelectMany(x => new double[] { x, 30 }).ToArray(); // linha horizontal
        return new RoadEdge(0, "R", "R", highway, "a", "b", pts, RoadGeometry.CellsOf(pts, Spec), RoadGeometry.Length(pts), offRoad);
    }

    static BarrierSet Roads(params RoadEdge[] edges) =>
        BarrierSet.Build(Spec, new RoadNetwork(Spec, edges, new Dictionary<string, RoadNode>()), Array.Empty<Waterway>(), TestSettings.All.Landscape.Barriers);

    static float[] Open() => Enumerable.Repeat(1f, N * N).ToArray();

    static double BlockedShare(float[] adj, float threshold) => Enumerable.Range(0, N).Count(x => adj[30 * N + x] <= threshold) / (double)N;

    [Fact]
    public void A_motorway_blocks_almost_everywhere_in_calm_weather_and_only_there()
    {
        var adj = Roads(Road("motorway")).Apply(Open(), 5, 1, Min);
        Assert.True(BlockedShare(adj, 0.1f) > 0.85, "em calma a autoestrada trava quase toda a extensão");
        Assert.Equal(1f, adj[10 * N + 10]);
    }

    [Fact]
    public void Strong_wind_breaches_more_of_the_barrier_than_calm()
    {
        var barriers = Roads(Road("motorway"));
        Assert.True(BlockedShare(barriers.Apply(Open(), 60, 1, Min), 0.1f) < BlockedShare(barriers.Apply(Open(), 5, 1, Min), 0.1f));
    }

    [Fact]
    public void Breaches_are_deterministic_per_seed_and_differ_between_seeds()
    {
        var barriers = Roads(Road("secondary"));
        Assert.Equal(barriers.Apply(Open(), 40, 3, Min), barriers.Apply(Open(), 40, 3, Min));
        Assert.NotEqual(barriers.Apply(Open(), 40, 3, Min), barriers.Apply(Open(), 40, 4, Min));
    }

    [Fact]
    public void Bigger_roads_hold_better_and_forest_tracks_do_not_count()
    {
        var settings = TestSettings.All.Landscape.Barriers;
        Assert.True(Roads(Road("motorway")).BreachProbability(settings.Roads["motorway"], 40) < Roads(Road("residential")).BreachProbability(settings.Roads["residential"], 40));
        Assert.Equal(0, Roads(Road("track", offRoad: true)).Count);
    }

    [Fact]
    public void A_breached_patch_still_slows_the_fire_and_never_goes_below_the_floor()
    {
        var adj = Roads(Road("motorway")).Apply(Open(), 80, 1, Min);
        Assert.All(Enumerable.Range(0, N).Select(x => adj[30 * N + x]), f => Assert.InRange(f, Min, (float)TestSettings.All.Landscape.Barriers.LeakFactor));
    }

    [Fact]
    public void A_river_blocks_every_cell_it_touches_along_a_diagonal_with_no_gap_for_calm_weather()
    {
        Coordinate At(double x, double y) { var (lat, lon) = Spec.ToLatLon(x, y); return new Coordinate(lon, lat); }
        var river = new Waterway(1, WaterwayKind.River, null, 20, Gf.CreateLineString(new[] { At(5, 5), At(50, 50) }));
        var barriers = BarrierSet.Build(Spec, new RoadNetwork(Spec, Array.Empty<RoadEdge>(), new Dictionary<string, RoadNode>()), new[] { river }, TestSettings.All.Landscape.Barriers);
        var adj = barriers.Apply(Open(), 5, 1, Min);
        for (int i = 6; i < 49; i++)
            Assert.True(adj[i * N + i] <= 0.05f || adj[i * N + i + 1] <= 0.05f, $"o rio tem uma fresta junto a ({i},{i})");
        Assert.Equal(1f, adj[5 * N + 50]);
    }
}
