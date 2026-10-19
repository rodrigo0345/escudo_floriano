using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

/// <summary>Cortar árvores e mato numa faixa muda o combustível das células e trava o fogo (e o fogo de copas) onde se corta.</summary>
public class FuelRemovalTests
{
    const int N = 40;
    static readonly GridSpec Spec = new(41.4, -8.3, N, N, 60);
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
    static readonly InterventionSettings Settings = TestSettings.All.Interventions;

    static TerrainGrids Forest() { var land = Enumerable.Repeat(LandCover.Eucalipto, N * N).ToArray(); return new TerrainGrids(Spec, new float[N * N], land, new ushort[N * N]); }

    static LineString Vertical(int column)
    {
        Coordinate At(int y) { var (lat, lon) = Spec.ToLatLon(column, y); return new Coordinate(lon, lat); }
        return Gf.CreateLineString(new[] { At(2), At(N - 3) });
    }

    static InterventionEffect Cut(FuelRemoval removal, double? width = null)
    {
        var g = Forest();
        var baseline = Enumerable.Repeat(1f, N * N).ToArray();
        var cut = new FuelRemovalIntervention { Start = new TimeSpec(OffsetMinutes: 0), Geometry = Vertical(20), Removal = removal, WidthM = width };
        return InterventionApplier.Apply(new[] { cut }, g, Array.Empty<Place>(), baseline, TestSettings.All.Rules.Suppression, Settings);
    }

    static short Band(short[] bands, int band, int x, int y) => bands[band * N * N + y * N + x];

    [Fact]
    public void A_cut_line_is_a_connected_strip_at_least_one_and_a_half_cells_wide()
    {
        var cells = Cut(FuelRemoval.Trees, width: 5).Treatments.Single().Cells.ToHashSet();
        Assert.All(Enumerable.Range(3, N - 6), y => Assert.Contains(y * N + 20, cells));   // a linha inteira
        Assert.DoesNotContain(10 * N + 10, cells);                                          // e só ela
        Assert.True(cells.Count(c => c / N == 20) >= 1);
    }

    [Fact]
    public void Cutting_trees_removes_the_canopy_and_keeps_the_understory_fuel()
    {
        var treated = TestSettings.Landscape.Treat(TestSettings.Landscape.Bands(Forest()), N * N, Cut(FuelRemoval.Trees).Treatments, Settings.FuelRemoval);
        Assert.Equal(0, Band(treated, 4, 20, 20)); Assert.Equal(0, Band(treated, 7, 20, 20));      // sem copado nem densidade: sem fogo de copas
        Assert.Equal(145, Band(treated, 3, 20, 20));                                               // o mato fica
        Assert.True(Band(treated, 4, 5, 5) > 0, "fora da faixa nada muda");
    }

    [Fact]
    public void Clearing_the_understory_leaves_short_grass_and_clearing_everything_leaves_bare_ground()
    {
        var bands = TestSettings.Landscape.Bands(Forest());
        var understory = TestSettings.Landscape.Treat(bands, N * N, Cut(FuelRemoval.Understory).Treatments, Settings.FuelRemoval);
        var all = TestSettings.Landscape.Treat(bands, N * N, Cut(FuelRemoval.All).Treatments, Settings.FuelRemoval);
        Assert.Equal(Settings.FuelRemoval.UnderstoryFuelModel, Band(understory, 3, 20, 20));
        Assert.Equal(Settings.FuelRemoval.NonBurnableFuelModel, Band(all, 3, 20, 20));
        Assert.Equal(145, Band(bands, 3, 20, 20));            // as bandas partilhadas do local não foram alteradas
    }

    [Fact]
    public void Each_kind_of_cut_slows_the_fire_in_its_strip_and_the_stronger_cut_slows_it_more()
    {
        float AtStrip(FuelRemoval r) => Cut(r).Adjustment[20 * N + 20];
        Assert.Equal(1f, Cut(FuelRemoval.Trees).Adjustment[5 * N + 5]);
        Assert.True(AtStrip(FuelRemoval.Understory) < AtStrip(FuelRemoval.Trees));
        Assert.Equal((float)Settings.FuelRemoval.TreesSpreadFactor, AtStrip(FuelRemoval.Trees), 3);
    }

    [Fact]
    public void A_polygon_is_cut_whole()
    {
        var (lat0, lon0) = Spec.ToLatLon(10, 10); var (lat1, lon1) = Spec.ToLatLon(14, 14);
        var square = Gf.CreatePolygon(new[] { new Coordinate(lon0, lat0), new Coordinate(lon1, lat0), new Coordinate(lon1, lat1), new Coordinate(lon0, lat1), new Coordinate(lon0, lat0) });
        var cut = new FuelRemovalIntervention { Start = new TimeSpec(OffsetMinutes: 0), Geometry = square, Removal = FuelRemoval.All };
        var cells = InterventionApplier.TreatedCells(cut, Spec, Settings.FuelRemoval).ToHashSet();
        Assert.Contains(12 * N + 12, cells);
        Assert.DoesNotContain(20 * N + 20, cells);
    }
}
