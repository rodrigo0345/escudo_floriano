using FireTrace.Core.Common;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Services.Fire;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Coupling;
using FireTrace.Engine.Native;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Engine;

/// <summary>
/// As mesmas verificações físicas de <see cref="FireBehaviourTests"/> (ELMFIRE), mas contra o motor nativo — sem contentor, sempre disponível.
/// O motor nativo é deliberadamente menos fiel (Rothermel ligeiro + frente elíptica em vez da física completa); estes testes garantem que,
/// apesar disso, continua a responder ao que o descreve: vento, vegetação, declive e barreiras (estradas, rios, faixas cortadas).
/// </summary>
public class NativeFireEngineTests
{
    const int N = 60, IgnitionX = 10, IgnitionY = 30;
    static readonly GridSpec Spec = new(41.4, -8.3, N, N, 60);
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
    static readonly NativeFireEngine Engine = new(TestSettings.All.NativeEngine, TestSettings.All.FuelMoisture, Environment.ProcessorCount);

    static async Task<int[]> Burn(byte cover = LandCover.Pasto, double windKmh = 25, double windFrom = 270, double slopePercent = 0,
        IEnumerable<Waterway>? waterways = null, IEnumerable<RoadEdge>? roads = null, FuelRemoval? cutAtColumn14 = null, bool coupled = false, bool slopeNorthSouth = false)
    {
        var elevation = new float[N * N];
        // sobe para leste (encosta virada a oeste) por omissão; `slopeNorthSouth` sobe para sul (linha N-1), encosta virada a norte
        for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) elevation[y * N + x] = (float)((slopeNorthSouth ? y : x) * slopePercent * Spec.CellM / 100);
        var land = new byte[N * N]; Array.Fill(land, cover);
        var terrain = new TerrainGrids(Spec, elevation, land, new ushort[N * N]);
        var network = new RoadNetwork(Spec, (roads ?? Array.Empty<RoadEdge>()).ToList(), new Dictionary<string, RoadNode>());
        var landscape = TestSettings.FlatLandscape; // sem ruído: uma causa de cada vez
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
        var job = new FireJob(Spec.ToEngineGrid(), bands, adjustment, new[] { new IgnitionCell(IgnitionX, IgnitionY) }, 60, new[] { member }, 0, Spotting: false);
        IFireEngine runner = coupled ? new CoupledFireEngine(Engine, TestSettings.All.Convection, TestSettings.All.Engine) : Engine;
        return (await runner.RunAsync(job))["rep"].Ignition;
    }

    static (int Cells, int East, int West, int NorthSouth) Extent(int[] toa)
    {
        var xs = Enumerable.Range(0, toa.Length).Where(i => toa[i] >= 0).Select(i => (X: i % N, Y: i / N)).ToArray();
        return xs.Length == 0 ? (0, 0, 0, 0) : (xs.Length, xs.Max(p => p.X) - IgnitionX, IgnitionX - xs.Min(p => p.X), Math.Max(IgnitionY - xs.Min(p => p.Y), xs.Max(p => p.Y) - IgnitionY));
    }

    static Waterway River(int column, WaterwayKind kind = WaterwayKind.River)
    {
        Coordinate At(int y) { var (lat, lon) = Spec.ToLatLon(column, y); return new Coordinate(lon, lat); }
        return new Waterway(1, kind, "teste", 25, Gf.CreateLineString(new[] { At(0), At(N - 1) }));
    }

    [Fact]
    public async Task Wind_pushes_the_fire_downwind()
    {
        var west = await Burn(windFrom: 270); var north = await Burn(windFrom: 0);
        var (w, n) = (Extent(west), Extent(north));
        Assert.True(w.East > 3 * w.West, $"vento de oeste: a frente devia ir para leste (E {w.East}, O {w.West})");
        Assert.True(n.NorthSouth > 2 * Math.Max(n.East, n.West), $"vento de norte: a frente devia ir para sul (N-S {n.NorthSouth}, E {n.East}, O {n.West})");
    }

    [Fact]
    public async Task A_stronger_wind_burns_more()
    {
        var calm = await Burn(windKmh: 5); var windy = await Burn(windKmh: 25);
        Assert.True(Extent(windy).Cells > 2 * Extent(calm).Cells, $"calmo {Extent(calm).Cells}, ventoso {Extent(windy).Cells}");
    }

    [Fact]
    public async Task Vegetation_decides_how_much_burns_and_eucalyptus_guides_the_fire()
    {
        var grass = await Burn(LandCover.Pasto); var crops = await Burn(LandCover.Agricola); var euc = await Burn(LandCover.Eucalipto);
        var pine = await Burn(LandCover.Pinheiro); var broadleaf = await Burn(LandCover.Folhosas);
        var urban = await Burn(LandCover.Urbano); var water = await Burn(LandCover.Agua); var rock = await Burn(LandCover.Rocha);
        Assert.True(Extent(grass).Cells > Extent(crops).Cells);
        Assert.True(Extent(euc).Cells > Extent(pine).Cells, $"euc {Extent(euc).Cells}, pinheiro {Extent(pine).Cells}");
        Assert.True(Extent(pine).Cells > Extent(broadleaf).Cells, $"pinheiro {Extent(pine).Cells}, folhosas {Extent(broadleaf).Cells}");
        Assert.All(new[] { urban, water, rock }, b => Assert.True(Extent(b).Cells <= 2, "o que não é combustível não propaga")); // o próprio ponto de ignição pode contar
    }

    [Fact]
    public async Task Fire_runs_faster_uphill()
    {
        var flat = await Burn(windKmh: 5); var slope = await Burn(windKmh: 5, slopePercent: 30);
        Assert.True(Extent(slope).Cells > Extent(flat).Cells, $"plano {Extent(flat).Cells}, declive {Extent(slope).Cells}");
    }

    [Fact]
    public async Task A_south_facing_slope_is_drier_and_burns_more_than_a_north_facing_one()
    {
        // vento calmo: o que domina a diferença é a humidade (face da encosta), não a direção do declive em si
        var south = await Burn(windKmh: 3, slopePercent: -25, slopeNorthSouth: true);  // desce para sul: virada a sul
        var north = await Burn(windKmh: 3, slopePercent: 25, slopeNorthSouth: true);   // desce para norte: virada a norte
        Assert.True(Extent(south).Cells > Extent(north).Cells, $"sul {Extent(south).Cells}, norte {Extent(north).Cells}");
    }

    [Fact]
    public async Task A_dense_canopy_shelters_the_surface_fire_from_the_wind()
    {
        // mesmo combustível de base (SpreadFactor igual): só a cobertura do copado muda, para isolar o abrigo do vento do resto
        var land = Enumerable.Repeat(LandCover.Eucalipto, N * N).ToArray();
        var terrain = new TerrainGrids(Spec, new float[N * N], land, new ushort[N * N]);
        var network = new RoadNetwork(Spec, Array.Empty<RoadEdge>(), new Dictionary<string, RoadNode>());
        // sem densidade/base de copa não há fogo de copas possível nem aqui nem na versão "aberta" — isola-se só o abrigo do vento pela cobertura
        var noCrown = (short[])TestSettings.FlatLandscape.Bands(terrain).Clone();
        Array.Fill(noCrown, (short)0, 6 * N * N, 2 * N * N); // bandas 6 (base) e 7 (densidade)
        var bands = noCrown;
        var bare = (short[])bands.Clone();
        Array.Fill(bare, (short)0, 4 * N * N, N * N); // banda 4 = cobertura do copado (abriga o vento)
        var adjustment = TestSettings.FlatLandscape.Adjustment(terrain, Array.Empty<Firebreak>(), Array.Empty<Waterway>());
        var barriers = BarrierSet.Build(Spec, network, Array.Empty<Waterway>(), TestSettings.All.Landscape.Barriers);
        var member = new MemberWeather("rep", WeatherTrack.Constant(25, 270, 25), barriers.Apply(adjustment, 25, 1, TestSettings.All.Landscape.MinAdjustmentFactor));
        async Task<int[]> Run(short[] b) => (await Engine.RunAsync(new FireJob(Spec.ToEngineGrid(), b, adjustment, new[] { new IgnitionCell(IgnitionX, IgnitionY) }, 60, new[] { member }, 0, Spotting: false)))["rep"].Ignition;
        var sheltered = await Run(bands); var open = await Run(bare);
        Assert.True(Extent(open).Cells > Extent(sheltered).Cells, $"aberto {Extent(open).Cells}, abrigado {Extent(sheltered).Cells}");
    }

    [Fact]
    public async Task Dense_canopy_eucalyptus_reaches_crown_fire_and_a_bare_canopy_version_of_it_does_not()
    {
        var land = Enumerable.Repeat(LandCover.Eucalipto, N * N).ToArray();
        var terrain = new TerrainGrids(Spec, new float[N * N], land, new ushort[N * N]);
        var network = new RoadNetwork(Spec, Array.Empty<RoadEdge>(), new Dictionary<string, RoadNode>());
        var bands = TestSettings.FlatLandscape.Bands(terrain);
        var bare = (short[])bands.Clone();
        for (int band = 4; band <= 7; band++) Array.Fill(bare, (short)0, band * N * N, N * N); // sem copado: não pode entrar em fogo de copas
        var adjustment = TestSettings.FlatLandscape.Adjustment(terrain, Array.Empty<Firebreak>(), Array.Empty<Waterway>());
        var barriers = BarrierSet.Build(Spec, network, Array.Empty<Waterway>(), TestSettings.All.Landscape.Barriers);
        var member = new MemberWeather("rep", WeatherTrack.Constant(30, 270, 25), barriers.Apply(adjustment, 30, 1, TestSettings.All.Landscape.MinAdjustmentFactor));
        async Task<FireResult> Run(short[] b) => (await Engine.RunAsync(new FireJob(Spec.ToEngineGrid(), b, adjustment, new[] { new IgnitionCell(IgnitionX, IgnitionY) }, 60, new[] { member }, 0, Spotting: false)))["rep"];
        var canopy = await Run(bands); var sem = await Run(bare);
        Assert.Contains(canopy.Flags, f => (f & 1) != 0);
        Assert.DoesNotContain(sem.Flags, f => (f & 1) != 0);
        Assert.True(Extent(canopy.Ignition).Cells > Extent(sem.Ignition).Cells, "o fogo de copas devia alargar a área ardida");
    }

    [Fact]
    public async Task A_river_stops_the_fire_and_a_dry_stream_barely_slows_it()
    {
        var open = await Burn(); var river = await Burn(waterways: new[] { River(14) }); var stream = await Burn(waterways: new[] { River(14, WaterwayKind.Stream) });
        int beyond(int[] toa) => Enumerable.Range(0, toa.Length).Count(i => toa[i] >= 0 && i % N > 14);
        Assert.True(beyond(open) > 0, "sem barreira o fogo passa a coluna 14");
        Assert.Equal(0, beyond(river));
        Assert.True(beyond(stream) > 0, "uma ribeira não trava o fogo");
    }

    [Fact]
    public async Task A_motorway_slows_the_fire_that_crosses_it()
    {
        double[] pts = Enumerable.Range(0, N).SelectMany(y => new double[] { 14, y }).ToArray();
        var road = new RoadEdge(0, "A11", "A11", "motorway", "a", "b", pts, RoadGeometry.CellsOf(pts, Spec), RoadGeometry.Length(pts));
        var open = await Burn(LandCover.Mato, windKmh: 10); var withRoad = await Burn(LandCover.Mato, windKmh: 10, roads: new[] { road });
        int beyond(int[] toa) => Enumerable.Range(0, toa.Length).Count(i => toa[i] >= 0 && i % N > 14);
        Assert.True(beyond(open) > 1, "sem estrada o fogo passa a coluna 14");
        Assert.True(beyond(withRoad) * 3 < beyond(open), "a autoestrada atrasa a frente em vento fraco");
    }

    [Fact]
    public async Task A_cleared_strip_stops_the_fire()
    {
        var open = await Burn(LandCover.Eucalipto, windKmh: 25, cutAtColumn14: null);
        var cleared = await Burn(LandCover.Eucalipto, windKmh: 25, cutAtColumn14: FuelRemoval.All);
        int beyond(int[] toa) => Enumerable.Range(0, toa.Length).Count(i => toa[i] >= 0 && i % N > 14);
        Assert.True(beyond(open) > 0, "sem faixa o fogo passa a coluna 14");
        Assert.Equal(0, beyond(cleared));
    }

    [Fact]
    public async Task The_fire_changes_its_own_wind_and_the_burn_stays_in_the_same_order_of_magnitude()
    {
        var plain = await Burn(LandCover.Eucalipto); var coupled = await Burn(LandCover.Eucalipto, coupled: true);
        Assert.NotEqual(plain, coupled);
        Assert.InRange(Extent(coupled).Cells, Extent(plain).Cells * 0.4, Extent(plain).Cells * 1.8);
    }

    [Fact]
    public async Task Runs_in_well_under_a_second_for_a_grid_this_size()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        await Burn(LandCover.Eucalipto, windKmh: 25);
        Assert.True(sw.ElapsedMilliseconds < 1000, $"demorou {sw.ElapsedMilliseconds} ms");
    }



}
