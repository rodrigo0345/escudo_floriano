using FireTrace.Core.Services.Routing;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Services;

public class RoutingTests
{
    // Uma rede em "H": duas vias horizontais (y=5 e y=15) ligadas por uma vertical (x=10) e por um caminho florestal (x=20).
    static readonly GridSpec Spec = new(41.4, -8.3, 30, 20, 100);

    static RoadEdge Edge(int id, string cls, string a, string b, bool offRoad, params double[] pts) =>
        new(id, $"via{id}", "", cls, a, b, pts, RoadGeometry.CellsOf(pts, Spec), RoadGeometry.Length(pts), offRoad);

    static RoadNetwork Net()
    {
        var edges = new[]
        {
            Edge(0, "primary", "wn", "wm", false, 2, 5, 10, 5), Edge(1, "primary", "wm", "we", false, 10, 5, 25, 5),
            Edge(2, "primary", "sn", "sm", false, 2, 15, 10, 15), Edge(3, "primary", "sm", "se", false, 10, 15, 25, 15),
            Edge(4, "secondary", "wm", "sm", false, 10, 5, 10, 15), Edge(5, "track", "we", "se", true, 25, 5, 25, 15),
        };
        var nodes = new Dictionary<string, RoadNode>
        {
            ["wn"] = new("wn", 2, 5), ["wm"] = new("wm", 10, 5), ["we"] = new("we", 25, 5), ["sn"] = new("sn", 2, 15), ["sm"] = new("sm", 10, 15), ["se"] = new("se", 25, 15),
        };
        return new RoadNetwork(Spec, edges, nodes);
    }

    static RoadSpeeds Speeds => TestSettings.Speeds;

    static Anchor At(string key, double x, double y) => new(key, x, y);

    [Fact]
    public void Shortest_route_uses_the_vertical_link_and_ignores_forest_tracks_for_ordinary_vehicles()
    {
        var graph = RoadGraph.For(Net());
        var route = graph.Route(At("from", 2, 5), At("to", 25, 15), Speeds.Profile())!;
        Assert.Equal(new[] { 0, 4, 3 }, route.EdgeIds);
        Assert.True(route.Minutes > 0 && route.DistanceM > 2000);

        var road = graph.Route(At("from", 25, 5), At("to", 25, 15), Speeds.Profile())!; // sem viatura todo-o-terreno: dá a volta pelas vias
        Assert.DoesNotContain(5, road.EdgeIds);
    }

    [Fact]
    public void A_blocked_edge_forces_a_detour_or_isolates()
    {
        var graph = RoadGraph.For(Net());
        var detour = graph.Route(At("from", 2, 5), At("to", 25, 15), Speeds.Profile(), blocked: e => e == 4);
        Assert.Null(detour); // sem o caminho florestal e sem a vertical, as duas vias ficam separadas
        var withTracks = graph.Route(At("from", 2, 5), At("to", 25, 15), Speeds.Profile(allowOffRoad: true), blocked: e => e == 4)!;
        Assert.Contains(5, withTracks.EdgeIds);
    }

    [Fact]
    public void Access_times_are_the_best_over_all_origins()
    {
        var graph = RoadGraph.For(Net());
        var targets = new[] { At("north", 25, 5), At("south", 2, 15) };
        var times = graph.AccessTimes(new[] { At("a", 2, 5) }, targets, Speeds.Profile(emergency: false));
        var both = graph.AccessTimes(new[] { At("a", 2, 5), At("b", 2, 15) }, targets, Speeds.Profile(emergency: false));
        Assert.NotNull(times[0]); Assert.NotNull(times[1]);
        Assert.True(both[1] < times[1]); // a segunda origem está em cima do alvo sul
        Assert.Equal(times[0], both[0]);
    }

    [Fact]
    public void Emergency_vehicles_are_faster()
    {
        var edge = Net().Edges[0];
        Assert.True(Speeds.Profile(emergency: true).Minutes(edge, 100) < Speeds.Profile(emergency: false).Minutes(edge, 100));
        Assert.Null(Speeds.Profile().Minutes(Net().Edges[5], 100)); // caminho florestal sem viatura adequada
    }

    [Fact]
    public void Fire_cuts_a_road_while_it_burns_next_to_it()
    {
        var net = Net();
        var ignition = Enumerable.Repeat(-1, Spec.CellCount).ToArray();
        // o fogo chega à via 4 (x=10, y=10) ao minuto 30 e as células ardem 20 minutos
        ignition[10 * Spec.Width + 10] = 30;
        var burn = Enumerable.Repeat(20, Spec.CellCount).ToArray();
        var cuts = RoadCuts.Compute(net, ignition, burn);
        Assert.False(cuts.IsCut(4, 10));
        Assert.True(cuts.IsCut(4, 40));
        Assert.False(cuts.IsCut(4, 60));
        Assert.True(cuts.IsCutDuring(4, 25, 35));
        Assert.False(cuts.IsCutDuring(4, 0, 20));
        Assert.True(cuts.From[0] < 0); // a via 0 está longe do fogo
    }

    [Fact]
    public void A_wider_clearance_cuts_roads_further_from_the_fire()
    {
        var net = Net();
        var ignition = Enumerable.Repeat(-1, Spec.CellCount).ToArray();
        ignition[10 * Spec.Width + 14] = 30; // 4 células a leste da via 4 (x=10)
        var burn = Enumerable.Repeat(20, Spec.CellCount).ToArray();
        Assert.True(RoadCuts.Compute(net, ignition, burn).From[4] < 0);                  // só as vizinhas: a via 4 não está cortada
        Assert.True(RoadCuts.Compute(net, ignition, burn, radiusCells: 4).From[4] >= 0); // com folga de 4 células: está
    }

    [Fact]
    public void Steep_edges_are_slower_and_beyond_the_vehicle_limit_impassable()
    {
        var edge = Net().Edges[0];
        var flat = Speeds.Profile().Minutes(edge, Spec.CellM, 0)!.Value;
        var steep = Speeds.Profile().Minutes(edge, Spec.CellM, 20)!.Value;
        Assert.True(steep > flat);                                                          // acima de 8 % anda mais devagar
        Assert.Null(Speeds.Profile().Minutes(edge, Spec.CellM, 31));                        // acima do limite por omissão (30 %) não passa
        Assert.NotNull(Speeds.Profile(maxSlopePercent: 40).Minutes(edge, Spec.CellM, 35));  // uma viatura que vence 40 % passa
        Assert.Null(Speeds.Profile(maxSlopePercent: 10).Minutes(edge, Spec.CellM, 15));     // uma que só vence 10 % não passa
    }

    [Fact]
    public void A_vehicle_wider_than_the_road_cannot_use_it()
    {
        var edge = Net().Edges[0] with { WidthM = 3 };
        Assert.NotNull(Speeds.Profile(widthM: 2.5).Minutes(edge, Spec.CellM));
        Assert.Null(Speeds.Profile(widthM: 3.5).Minutes(edge, Spec.CellM));
        Assert.NotNull(Speeds.Profile(widthM: 3.5).Minutes(edge with { WidthM = null }, Spec.CellM)); // largura desconhecida: não se impede
    }

    [Fact]
    public void Routing_detours_around_a_steep_edge()
    {
        var graph = RoadGraph.For(Net()).WithSlopes(new double[] { 0, 0, 0, 0, 50, 0 }); // a vertical (4) é íngreme demais
        Assert.Null(graph.Route(At("from", 2, 5), At("to", 25, 15), Speeds.Profile()));   // sem a vertical e sem o caminho florestal não há via
        var offRoad = graph.Route(At("from", 2, 5), At("to", 25, 15), Speeds.Profile(allowOffRoad: true))!;
        Assert.DoesNotContain(4, offRoad.EdgeIds);
        Assert.Contains(5, offRoad.EdgeIds);
    }

    static double AverageKmh(TravelProfile profile, RoadEdge edge) => edge.LengthCells * Spec.CellM / 1000 / (profile.Minutes(edge, Spec.CellM)!.Value / 60);

    [Fact]
    public void Dirt_roads_are_slower_by_quality_and_heavy_vehicles_suffer_more_on_them()
    {
        var road = Edge(10, "tertiary", "a", "b", false, 2, 5, 12, 5);
        var good = Edge(11, "track", "a", "b", false, 2, 5, 12, 5) with { TrackType = "grade2" };
        var rough = Edge(12, "track", "a", "b", true, 2, 5, 12, 5) with { TrackType = "grade5" };
        var ordinary = Speeds.Profile(allowOffRoad: true, emergency: false);
        Assert.True(AverageKmh(ordinary, road) > AverageKmh(ordinary, good));
        Assert.True(AverageKmh(ordinary, good) > AverageKmh(ordinary, rough));

        var light = Speeds.Profile(allowOffRoad: true, emergency: false, vehicleType: "all_terrain_patrol");
        var heavy = Speeds.Profile(allowOffRoad: true, emergency: false, vehicleType: "tanker_large");
        Assert.True(AverageKmh(light, good) > AverageKmh(heavy, good));
    }

    [Fact]
    public void Sirens_speed_up_paved_roads_but_not_dirt_roads()
    {
        var road = Edge(10, "tertiary", "a", "b", false, 2, 5, 12, 5);
        var dirt = Edge(12, "track", "a", "b", true, 2, 5, 12, 5) with { TrackType = "grade4" };
        Assert.True(AverageKmh(Speeds.Profile(emergency: true), road) > AverageKmh(Speeds.Profile(emergency: false), road));
        Assert.Equal(AverageKmh(Speeds.Profile(allowOffRoad: true, emergency: true), dirt), AverageKmh(Speeds.Profile(allowOffRoad: true, emergency: false), dirt), 6);
    }

    [Fact]
    public void Sharp_bends_slow_a_road_and_heavy_vehicles_are_capped()
    {
        var straight = Edge(10, "secondary", "a", "b", false, 2, 5, 12, 5);
        var winding = Edge(11, "secondary", "a", "b", false, 2, 5, 3, 5, 3, 6, 4, 6, 4, 7, 5, 7, 5, 8, 6, 8, 6, 9, 7, 9);
        var profile = Speeds.Profile();
        Assert.True(AverageKmh(profile, straight) > AverageKmh(profile, winding));

        var motorway = Edge(12, "motorway", "a", "b", false, 2, 5, 12, 5);
        Assert.True(AverageKmh(Speeds.Profile(weightT: 12), motorway) < AverageKmh(Speeds.Profile(weightT: 2), motorway));
    }

    [Fact]
    public void A_posted_speed_limit_replaces_the_class_default_and_binds_every_vehicle()
    {
        var unposted = Edge(10, "tertiary", "a", "b", false, 2, 5, 12, 5);
        var slow = unposted with { MaxSpeedKmh = 30 };
        var fast = unposted with { MaxSpeedKmh = 90 };
        var profile = Speeds.Profile(emergency: false);
        Assert.True(AverageKmh(profile, slow) < AverageKmh(profile, unposted));
        Assert.True(AverageKmh(profile, fast) > AverageKmh(profile, unposted));

        var dirt = Edge(11, "track", "a", "b", true, 2, 5, 12, 5) with { TrackType = "grade1", MaxSpeedKmh = 20 };
        Assert.True(AverageKmh(Speeds.Profile(allowOffRoad: true, emergency: false, vehicleType: "all_terrain_patrol"), dirt) <= 20); // o limite assinalado vale também na terra
        Assert.True(AverageKmh(Speeds.Profile(weightT: 12), fast with { MaxSpeedKmh = 40 }) <= 40); // os pesados nunca passam do limite da via
    }
}
