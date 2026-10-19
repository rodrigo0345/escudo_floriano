using FireTrace.Core.Models.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

public class LandscapeTests
{
    const int N = 20;

    static TerrainGrids Grid(Func<int, int, float>? elevation = null, byte cover = LandCover.Eucalipto)
    {
        var spec = new GridSpec(41.4, -8.3, N, N, 60);
        var elev = new float[N * N]; var land = new byte[N * N]; Array.Fill(land, cover);
        if (elevation is not null) for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) elev[y * N + x] = elevation(x, y);
        return new TerrainGrids(spec, elev, land, new ushort[N * N]);
    }

    static short Band(short[] bands, int band, int x, int y) => bands[band * N * N + y * N + x];

    [Fact]
    public void Slope_and_aspect_follow_the_terrain()
    {
        var east = TestSettings.Landscape.Bands(Grid(elevation: (x, _) => x * 12f)); // sobe para leste 20 %: a encosta olha para oeste
        Assert.InRange(Band(east, 1, 10, 10), 10, 13);
        Assert.InRange(Band(east, 2, 10, 10), 268, 272);
        var south = TestSettings.Landscape.Bands(Grid(elevation: (_, y) => y * 12f)); // sobe para sul: olha para norte
        Assert.True(Band(south, 2, 10, 10) is <= 2 or >= 358);
    }

    [Fact]
    public void Vegetation_drives_fuel_and_canopy()
    {
        var eucalyptus = TestSettings.Landscape.Bands(Grid(cover: LandCover.Eucalipto));
        Assert.Equal(145, Band(eucalyptus, 3, 5, 5)); // SH5
        Assert.True(Band(eucalyptus, 4, 5, 5) > 0);   // cobertura do copado
        var water = TestSettings.Landscape.Bands(Grid(cover: LandCover.Agua));
        Assert.Equal(98, Band(water, 3, 5, 5));       // NB8
        Assert.Equal(0, Band(water, 4, 5, 5));
        Assert.Equal(91, Band(TestSettings.Landscape.Bands(Grid(cover: LandCover.Urbano)), 3, 5, 5)); // NB1
    }

    [Fact]
    public void Houses_reduce_fuel_and_spread()
    {
        var g = Grid();
        g.Buildings[5 * N + 5] = 30; // aglomerado denso
        g.Buildings[8 * N + 8] = 2;  // casas dispersas
        var bands = TestSettings.Landscape.Bands(g);
        Assert.Equal(91, Band(bands, 3, 5, 5));
        Assert.Equal(145, Band(bands, 3, 8, 8));
        var adj = TestSettings.FlatLandscape.Adjustment(g, Array.Empty<Firebreak>(), Array.Empty<Waterway>());
        Assert.True(adj[5 * N + 5] < adj[8 * N + 8] && adj[8 * N + 8] < adj[2 * N + 2]);
        Assert.Equal((float)(TestSettings.Fuels.Get(LandCover.Eucalipto).SpreadFactor * TestSettings.All.Landscape.SpreadCalibration), adj[2 * N + 2], 4);
    }

}
