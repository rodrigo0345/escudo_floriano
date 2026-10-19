using FireTrace.Core.Models.Fire;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

public class SpreadVariabilityTests
{
    [Fact]
    public void The_noise_is_deterministic_bounded_and_averages_one()
    {
        var a = SpreadNoise.Field(120, 120, 4, seed: 7); var b = SpreadNoise.Field(120, 120, 4, seed: 7); var other = SpreadNoise.Field(120, 120, 4, seed: 8);
        Assert.Equal(a, b);
        Assert.NotEqual(a, other);
        Assert.All(a, v => Assert.InRange(v, 0f, 1f));
        var factors = a.Select(v => SpreadNoise.Factor(v, 0.25)).ToArray();
        Assert.InRange(factors.Average(), 0.95, 1.05);
        Assert.InRange(factors.Min(), 0.75, 0.9); Assert.InRange(factors.Max(), 1.1, 1.25); // varia de facto, dentro de 1 ± amplitude
    }

    [Fact]
    public void Neighbouring_cells_vary_smoothly_in_patches()
    {
        var field = SpreadNoise.Field(60, 60, 4, 7);
        double step = Enumerable.Range(0, 59).Average(x => Math.Abs(field[30 * 60 + x + 1] - field[30 * 60 + x]));
        double far = Enumerable.Range(0, 50).Average(x => Math.Abs(field[30 * 60 + x + 10] - field[30 * 60 + x]));
        Assert.True(far > 2 * step, "as manchas têm vários pixéis: células vizinhas parecem-se mais que células distantes");
    }

    [Fact]
    public void The_adjustment_carries_the_noise_unless_the_amplitude_is_zero()
    {
        var spec = new GridSpec(41.4, -8.3, 30, 30, 60);
        var terrain = new TerrainGrids(spec, new float[900], Enumerable.Repeat(LandCover.Pasto, 900).ToArray(), new ushort[900]);
        var net = new RoadNetwork(spec, Array.Empty<RoadEdge>(), new Dictionary<string, RoadNode>());
        var noisy = TestSettings.Landscape.Adjustment(terrain, Array.Empty<Firebreak>(), Array.Empty<Waterway>());
        var flat = TestSettings.FlatLandscape.Adjustment(terrain, Array.Empty<Firebreak>(), Array.Empty<Waterway>());
        Assert.All(flat, f => Assert.Equal((float)TestSettings.Fuels.Get(LandCover.Pasto).SpreadFactor * (float)TestSettings.All.Landscape.SpreadCalibration, f, 4));
        Assert.True(noisy.Distinct().Count() > 100);
        Assert.InRange(noisy.Max(), flat[0], flat[0] * (1 + TestSettings.All.Landscape.SpreadVariability.Amplitude) + 1e-6);
    }
}
