using FireTrace.Engine.Native;

namespace FireTrace.Tests.Engine;

/// <summary>
/// The Rothermel core against the published equations: the reference values were produced independently (pyretechnics/Behave formulation) for the
/// same fuel models and moistures, so a change in the C# port that breaks the physics fails here before it reaches the map.
/// </summary>
public class RothermelTests
{
    static SurfaceFireBehavior Surface(int code, double windFtMin, double liveHerb = 0.40, double liveWoody = 0.80) =>
        RothermelSurfaceFire.Compute(FuelModelCatalog.For(code), 0.06, 0.08, 0.10, liveHerb, liveWoody, windFtMin, 0, 90, 90);

    [Theory]
    [InlineData(102, 0, 0.66, 29.4)]     // GR2, no wind
    [InlineData(102, 200, 5.67, 252)]    // GR2, light midflame wind
    [InlineData(102, 550, 22.49, 1000)]  // GR2, strong midflame wind
    [InlineData(145, 0, 0.95, 279)]      // SH5 (mato), no wind
    [InlineData(145, 550, 32.25, 9505)]  // SH5, strong midflame wind
    public void Matches_the_published_Rothermel_rates(int code, double windFtMin, double rosMPerMin, double intensityKwm)
    {
        var b = Surface(code, windFtMin);
        Assert.InRange(b.MaxRosMPerMin, rosMPerMin * 0.97, rosMPerMin * 1.03);
        Assert.InRange(b.IntensityKwm, intensityKwm * 0.97, intensityKwm * 1.03);
    }

    [Fact]
    public void No_wind_and_no_slope_gives_the_base_rate_and_a_circular_front()
    {
        var b = Surface(145, 0);
        Assert.True(b.MaxRosMPerMin > 0);
        Assert.Equal(1, b.LengthToWidth, 3);
        Assert.Equal(0, b.EffectiveWindMPerMin, 3);
        Assert.Equal(b.NoWindRosMPerMin, b.MaxRosMPerMin, 6);
    }

    [Fact]
    public void Wind_and_slope_add_when_they_point_the_same_way_and_fight_when_they_do_not()
    {
        var fuel = FuelModelCatalog.For(145);
        double tan = Math.Tan(30 * Math.PI / 180);
        var aligned = RothermelSurfaceFire.Compute(fuel, 0.06, 0.08, 0.10, 0.40, 0.80, 550, tan, 90, 90);
        var opposed = RothermelSurfaceFire.Compute(fuel, 0.06, 0.08, 0.10, 0.40, 0.80, 550, tan, 90, 270);
        var flat = Surface(145, 550);
        Assert.True(aligned.MaxRosMPerMin > flat.MaxRosMPerMin);
        Assert.True(opposed.MaxRosMPerMin < aligned.MaxRosMPerMin);
        Assert.InRange(aligned.DirectionDeg, 45, 90);
    }

    [Fact]
    public void Cured_grass_burns_faster_than_green_grass_and_wet_live_shrubs_burn_slower()
    {
        Assert.True(Surface(102, 550, liveHerb: 0.30).MaxRosMPerMin > Surface(102, 550, liveHerb: 1.50).MaxRosMPerMin);
        Assert.True(Surface(145, 550, liveWoody: 0.60).MaxRosMPerMin > Surface(145, 550, liveWoody: 1.80).MaxRosMPerMin);
    }

    [Fact]
    public void A_patchy_canopy_shelters_less_than_a_closed_one_but_more_than_open_ground()
    {
        double open = WindAdjustmentFactor.Of(6, 22 * 3.28084, 0);
        double patchy = WindAdjustmentFactor.Of(6, 22 * 3.28084, 0.35);
        double closed = WindAdjustmentFactor.Of(6, 22 * 3.28084, 1.0);
        Assert.True(open > patchy && patchy > closed, $"aberto {open}, 35% {patchy}, fechado {closed}");
    }

    [Fact]
    public void Non_burnable_codes_carry_no_fuel()
    {
        Assert.False(FuelModelCatalog.For(98).Burnable);
        Assert.False(FuelModelCatalog.For(99).Burnable);
        Assert.True(FuelModelCatalog.For(147).Burnable);
        Assert.Equal(0, Surface(99, 550).MaxRosMPerMin);
    }
}
