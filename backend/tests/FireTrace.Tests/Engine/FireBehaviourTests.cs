using FireTrace.Core.Common;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Services.Fire;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Coupling;
using FireTrace.Engine.Elmfire;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Engine;

/// <summary>
/// O fogo responde ao que o descreve: vento, vegetação, declive e barreiras (estradas, rios). Corre o ELMFIRE a sério numa paisagem uniforme de
/// 60×60 células e compara o que arde; se o contentor "engine" não estiver acessível (docker compose up engine), não faz nada.
/// </summary>
public class FireBehaviourTests
{
    const int N = 60, IgnitionX = 10, IgnitionY = 30;
    static readonly GridSpec Spec = new(41.4, -8.3, N, N, 60);
    static readonly string Url = Environment.GetEnvironmentVariable("ENGINE_URL") ?? "http://localhost:9000";
    static readonly string Jobs = Environment.GetEnvironmentVariable("FIRETRACE_JOBS") ?? Path.Combine(TestSettings.Root, "data", "jobs");
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);

    static async Task<bool> EngineAvailable()
    {
        using var probe = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        try { (await probe.GetAsync($"{Url}/health")).EnsureSuccessStatusCode(); } catch { return false; }
        return Directory.Exists(Jobs);
    }

    /// <summary>Uma hora de fogo numa grelha uniforme com a vegetação dada; devolve o minuto de chegada por célula (−1 = não ardeu) ou nada sem motor.</summary>
    static async Task<int[]?> Burn(byte cover = LandCover.Pasto, double windKmh = 25, double windFrom = 270, double slopePercent = 0, IEnumerable<Waterway>? waterways = null,
        IEnumerable<RoadEdge>? roads = null, bool variability = false, bool coupled = false, FuelRemoval? cutAtColumn14 = null, bool spotOn = false)
    {
        if (!await EngineAvailable()) return null;
        var elevation = new float[N * N];
        for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) elevation[y * N + x] = (float)(x * slopePercent * Spec.CellM / 100); // sobe para leste
        var land = new byte[N * N]; Array.Fill(land, cover);
        var terrain = new TerrainGrids(Spec, elevation, land, new ushort[N * N]);
        var network = new RoadNetwork(Spec, (roads ?? Array.Empty<RoadEdge>()).ToList(), new Dictionary<string, RoadNode>());
        var landscape = variability ? TestSettings.Landscape : TestSettings.FlatLandscape;
        var adjustment = landscape.Adjustment(terrain, Array.Empty<Firebreak>(), waterways ?? Array.Empty<Waterway>());
        var bands = landscape.Bands(terrain);
        if (cutAtColumn14 is { } removal)
        {
            var cut = new FuelRemovalIntervention { Start = new TimeSpec(OffsetMinutes: 0), Geometry = River(14).Geometry, Removal = removal };
            var effect = InterventionApplier.Apply(new[] { cut }, terrain, Array.Empty<Place>(), adjustment, TestSettings.All.Rules.Suppression, TestSettings.All.Interventions);
            adjustment = effect.Adjustment; bands = landscape.Treat(bands, Spec.CellCount, effect.Treatments, TestSettings.All.Interventions.FuelRemoval);
        }
        var barriers = BarrierSet.Build(Spec, network, waterways ?? Array.Empty<Waterway>(), TestSettings.All.Landscape.Barriers);
        var member = new MemberWeather("rep", WeatherTrack.Constant(windKmh, windFrom, 25), barriers.Apply(adjustment, windKmh, 1, TestSettings.All.Landscape.MinAdjustmentFactor));
        var job = new FireJob(Spec.ToEngineGrid(), bands, adjustment, new[] { new IgnitionCell(IgnitionX, IgnitionY) }, 60, new[] { member }, 60, Spotting: spotOn);
        var options = new ElmfireOptions(Jobs, Url, TestSettings.All.Engine.MetIntervalSeconds, 5, 3, 3, TestSettings.All.Engine.Spotting);
        var engine = new ElmfireEngine(new ElmfireClient(new HttpClient { Timeout = TimeSpan.FromMinutes(5) }, options), new ElmfireJobFiles(options, TestSettings.All.FuelMoisture), options, () => Guid.NewGuid().ToString("N"));
        IFireEngine runner = coupled ? new CoupledFireEngine(engine, TestSettings.All.Convection, TestSettings.All.Engine) : engine;
        return (await runner.RunAsync(job))["rep"].Ignition;
    }

    static (int Cells, int East, int West, int NorthSouth) Extent(int[] toa)
    {
        var xs = Enumerable.Range(0, toa.Length).Where(i => toa[i] >= 0).Select(i => (X: i % N, Y: i / N)).ToArray();
        return xs.Length == 0 ? (0, 0, 0, 0) : (xs.Length, xs.Max(p => p.X) - IgnitionX, IgnitionX - xs.Min(p => p.X), Math.Max(IgnitionY - xs.Min(p => p.Y), xs.Max(p => p.Y) - IgnitionY));
    }

    /// <summary>Um curso de água vertical (de norte a sul) sobre a coluna x.</summary>
    static Waterway River(int column, WaterwayKind kind = WaterwayKind.River)
    {
        Coordinate At(int y) { var (lat, lon) = Spec.ToLatLon(column, y); return new Coordinate(lon, lat); }
        return new Waterway(1, kind, "teste", 25, Gf.CreateLineString(new[] { At(0), At(N - 1) }));
    }

    [Fact]
    public async Task Wind_pushes_the_fire_downwind()
    {
        if (await Burn(windFrom: 270) is not { } west || await Burn(windFrom: 0) is not { } north) return;
        var (w, n) = (Extent(west), Extent(north));
        Assert.True(w.East > 3 * w.West, $"vento de oeste: a frente devia ir para leste (E {w.East}, O {w.West})");
        Assert.True(n.NorthSouth > 2 * Math.Max(n.East, n.West), $"vento de norte: a frente devia ir para sul (N-S {n.NorthSouth}, E {n.East}, O {n.West})");
    }

    [Fact]
    public async Task A_stronger_wind_burns_more()
    {
        if (await Burn(windKmh: 5) is not { } calm || await Burn(windKmh: 25) is not { } windy) return;
        Assert.True(Extent(windy).Cells > 3 * Extent(calm).Cells);
    }

    [Fact]
    public async Task Vegetation_decides_how_much_burns_and_eucalyptus_guides_the_fire()
    {
        if (await Burn(LandCover.Pasto) is not { } grass || await Burn(LandCover.Agricola) is not { } crops || await Burn(LandCover.Eucalipto) is not { } eucalyptus
            || await Burn(LandCover.Pinheiro) is not { } pine || await Burn(LandCover.Folhosas) is not { } broadleaf || await Burn(LandCover.Mato) is not { } scrub
            || await Burn(LandCover.Urbano) is not { } urban || await Burn(LandCover.Agua) is not { } water || await Burn(LandCover.Rocha) is not { } rock) return;
        Assert.True(Extent(grass).Cells > Extent(crops).Cells);          // pasto seco arde mais depressa que cultivo
        Assert.True(Extent(eucalyptus).Cells > Extent(pine).Cells);      // o eucaliptal é o que mais arde entre as florestas...
        Assert.True(Extent(pine).Cells > Extent(broadleaf).Cells);       // ...e as folhosas o que menos
        Assert.True(Extent(eucalyptus).Cells > Extent(grass).Cells);
        Assert.True(Extent(eucalyptus).Cells > Extent(scrub).Cells);
        Assert.InRange(Extent(eucalyptus).East, 12, 35);                 // frente do eucaliptal com vento forte: m/min plausíveis (≈ 1–2 km/h), não 3–5 km/h
        Assert.InRange(Extent(scrub).East, 10, 35);
        Assert.All(new[] { urban, water, rock }, burned => Assert.True(Extent(burned).Cells <= 2, "o que não é combustível não propaga"));
    }

    [Fact]
    public async Task Fire_runs_faster_uphill()
    {
        if (await Burn(windKmh: 5) is not { } flat || await Burn(windKmh: 5, slopePercent: 30) is not { } slope) return;
        Assert.True(Extent(slope).Cells > Extent(flat).Cells);
    }

    [Fact]
    public async Task A_river_stops_the_fire_and_a_dry_stream_barely_slows_it()
    {
        // sem rio a frente passa a coluna 14; com um rio nunca a ultrapassa; uma ribeira (seca no verão) passa
        if (await Burn() is not { } open || await Burn(waterways: new[] { River(14) }) is not { } river || await Burn(waterways: new[] { River(14, WaterwayKind.Stream) }) is not { } stream) return;
        int beyond(int[] toa) => Enumerable.Range(0, toa.Length).Count(i => toa[i] >= 0 && i % N > 14);
        Assert.True(beyond(open) > 0, "sem barreira o fogo passa a coluna 14");
        Assert.Equal(0, beyond(river));
        Assert.True(beyond(stream) > 0, "uma ribeira não trava o fogo");
    }

    [Fact]
    public async Task A_motorway_stops_the_fire_in_light_wind()
    {
        double[] pts = Enumerable.Range(0, N).SelectMany(y => new double[] { 14, y }).ToArray();
        var road = new RoadEdge(0, "A11", "A11", "motorway", "a", "b", pts, RoadGeometry.CellsOf(pts, Spec), RoadGeometry.Length(pts));
        if (await Burn(LandCover.Mato, windKmh: 10) is not { } open || await Burn(LandCover.Mato, windKmh: 10, roads: new[] { road }) is not { } withRoad) return;
        int beyond(int[] toa) => Enumerable.Range(0, toa.Length).Count(i => toa[i] >= 0 && i % N > 14);
        Assert.True(beyond(open) > 20, "sem estrada o fogo passa a coluna 14");
        Assert.True(beyond(withRoad) * 5 < beyond(open), "a autoestrada trava a frente em vento fraco");
    }

    [Fact]
    public async Task The_fire_changes_its_own_wind_and_the_burn_stays_in_the_same_order_of_magnitude()
    {
        if (await Burn(LandCover.Eucalipto) is not { } plain || await Burn(LandCover.Eucalipto, coupled: true) is not { } coupled) return;
        Assert.NotEqual(plain, coupled);
        Assert.InRange(Extent(coupled).Cells, Extent(plain).Cells * 0.4, Extent(plain).Cells * 1.6);
    }

    [Fact]
    public async Task In_weak_wind_vegetation_slope_and_barriers_still_decide_the_fire()
    {
        double[] pts = Enumerable.Range(0, N).SelectMany(y => new double[] { 14, y }).ToArray();
        var road = new RoadEdge(0, "N101", "N101", "primary", "a", "b", pts, RoadGeometry.CellsOf(pts, Spec), RoadGeometry.Length(pts));
        if (await Burn(LandCover.Eucalipto, windKmh: 5) is not { } eucalyptus || await Burn(LandCover.Folhosas, windKmh: 5) is not { } broadleaf
            || await Burn(LandCover.Eucalipto, windKmh: 25) is not { } strong || await Burn(LandCover.Eucalipto, windKmh: 5, slopePercent: 40) is not { } uphill
            || await Burn(LandCover.Mato, windKmh: 5) is not { } open || await Burn(LandCover.Mato, windKmh: 5, roads: new[] { road }) is not { } withRoad
            || await Burn(LandCover.Mato, windKmh: 5, waterways: new[] { River(14) }) is not { } withRiver) return;
        Assert.True(Extent(eucalyptus).Cells > Extent(broadleaf).Cells, "mesmo com vento fraco o eucaliptal arde mais que as folhosas");
        Assert.True(Extent(strong).Cells > 2 * Extent(eucalyptus).Cells, "o vento fraco não espalha o fogo como o forte");
        Assert.True(Extent(uphill).Cells > Extent(eucalyptus).Cells, "com vento fraco o declive conduz o fogo");
        int beyond(int[] toa) => Enumerable.Range(0, toa.Length).Count(i => toa[i] >= 0 && i % N > 14);
        Assert.True(Extent(open).East >= 4, "sem barreira o fogo avança para a coluna 14");
        Assert.Equal(0, beyond(withRoad));
        Assert.Equal(0, beyond(withRiver));
    }

    [Fact]
    public async Task A_cleared_strip_stops_the_fire_and_cutting_only_the_trees_removes_the_crown_fire()
    {
        if (await Burn(LandCover.Eucalipto, windKmh: 30) is not { } open || await Burn(LandCover.Eucalipto, windKmh: 30, cutAtColumn14: FuelRemoval.All) is not { } cleared
            || await Burn(LandCover.Eucalipto, windKmh: 30, cutAtColumn14: FuelRemoval.Understory) is not { } understory) return;
        int beyond(int[] toa) => Enumerable.Range(0, toa.Length).Count(i => toa[i] >= 0 && i % N > 14);
        Assert.True(beyond(open) > 0, "sem faixa o fogo passa a coluna 14");
        Assert.Equal(0, beyond(cleared));
        Assert.True(beyond(understory) < beyond(open), "uma faixa sem sub-bosque trava o fogo");
    }


    [Fact]
    public async Task Spread_variability_reaches_the_engine_and_keeps_the_same_order_of_magnitude()
    {
        if (await Burn(windKmh: 25) is not { } flat || await Burn(windKmh: 25, variability: true) is not { } noisy) return;
        Assert.NotEqual(flat, noisy);                                                    // o ruído chegou ao motor
        Assert.InRange(Extent(noisy).Cells, Extent(flat).Cells * 0.6, Extent(flat).Cells * 1.6); // sem mudar a ordem de grandeza do que arde
    }
}
