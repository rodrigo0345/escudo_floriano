using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Services;

/// <summary>O fumo vai para onde o vento sopra, sobe com a intensidade, tira visibilidade perto e a sotavento e dissipa-se; as consultas dizem quando volta a ser seguro.</summary>
public class SmokePlumeTests
{
    const int N = 80;
    static readonly GridSpec Spec = new(41.4, -8.3, N, N, 60);
    static readonly SmokePlume Plume = new(TestSettings.All.Smoke);
    static readonly DateTimeOffset Start = DateTimeOffset.Parse("2026-08-17T14:00:00Z"); // 14 h UTC: dia
    static readonly int[] Burn = Enumerable.Repeat(10, N * N).ToArray();

    /// <summary>Uma frente vertical que avança para leste uma coluna a cada 3 min a partir da coluna 20 (linhas 30–49), com vento constante (km/h, de onde sopra).</summary>
    static (FireRun Run, WindDisplacement Wind) Burning(ushort intensity = 6000, double windKmh = 10, double from = 270, int minutes = 60, bool crown = false, DateTimeOffset? start = null)
    {
        var ign = Enumerable.Repeat(-1, N * N).ToArray(); var flin = new ushort[N * N]; var flags = new byte[N * N];
        for (int k = 0; k < 20 && 3 * k <= minutes; k++)
            for (int y = 30; y < 50; y++) { ign[y * N + 20 + k] = 3 * k; flin[y * N + 20 + k] = intensity; flags[y * N + 20 + k] = (byte)(crown ? 1 : 0); }
        var weather = Enumerable.Range(0, minutes / 10 + 1).Select(i => new WeatherSample { Time = (start ?? Start).AddMinutes(i * 10), WindKmh = windKmh, WindFromDeg = from, HumidityPct = 30, TempC = 30 }).ToList();
        var run = new FireRun { SimulationId = "s", LocationId = "l", Spec = Spec, Start = start ?? Start, DurationMinutes = minutes, Ignition = ign, Members = Array.Empty<int[]>(), IntensityKwm = flin, Flags = flags, Weather = weather };
        return (run, new WindDisplacement(run, minutes + TestSettings.All.Smoke.Dispersion.PuffLifetimeMinutes + 2));
    }

    static double Ground(FireRun run, WindDisplacement wind, int t, double col, double row)
    {
        var puffs = Plume.Puffs(run, Burn, wind, t);
        return Plume.GroundConcentration(puffs, Plume.Stability(run, wind.SpeedMs(t), t), (col + 0.5) * Spec.CellM, (row + 0.5) * Spec.CellM);
    }

    [Fact]
    public void Smoke_drifts_downwind_and_is_far_worse_downwind_than_upwind()
    {
        var (run, wind) = Burning(from: 270); // vento de oeste: o fumo vai para leste
        double downwind = Ground(run, wind, 40, 50, 40), upwind = Ground(run, wind, 40, 8, 40);
        Assert.True(downwind > 20 * Math.Max(upwind, 1e-6), $"sotavento {downwind:0} µg/m³, barlavento {upwind:0}");
        Assert.True(downwind > 10, "o fumo chega ao chão a sotavento");
    }

    [Fact]
    public void A_stronger_fire_makes_more_smoke_and_a_crown_fire_rises_higher()
    {
        var (weak, weakWind) = Burning(intensity: 800); var (strong, strongWind) = Burning(intensity: 12000);
        Assert.True(Ground(strong, strongWind, 40, 45, 40) > Ground(weak, weakWind, 40, 45, 40));
        Assert.True(Plume.PlumeHeightM(4000, crown: true) > Plume.PlumeHeightM(4000, crown: false));
        Assert.True(Plume.PlumeHeightM(8000, false) > Plume.PlumeHeightM(1000, false));
    }

    [Fact]
    public void Smoke_thins_out_with_distance_and_after_the_fire_dies_down()
    {
        var (run, wind) = Burning();
        Assert.True(Ground(run, wind, 40, 36, 40) > Ground(run, wind, 40, 75, 40), "mais longe, menos fumo");
        double during = Ground(run, wind, 40, 45, 40), long_after = Ground(run, wind, 60 + TestSettings.All.Smoke.Dispersion.PuffLifetimeMinutes + 20, 45, 40); // a frente acaba aos 57 min; passado o tempo de vida das nuvens já não há fumo
        Assert.True(long_after < during * 0.1, "passado o tempo de vida das nuvens o fumo desapareceu");
    }

    [Fact]
    public void Visibility_follows_koschmieder_and_classes_get_worse_with_concentration()
    {
        var clear = Plume.Visibility(0); var haze = Plume.Visibility(500); var dense = Plume.Visibility(8000);
        Assert.Equal(TestSettings.All.Smoke.Dispersion.ClearVisibilityM, clear.VisibilityM);
        Assert.Equal(0, clear.Class);
        Assert.True(haze.VisibilityM > dense.VisibilityM && haze.Class < dense.Class);
        Assert.Equal(3.912 / (TestSettings.All.Smoke.Dispersion.MassExtinctionM2g * 8000e-6), dense.VisibilityM, 1);
        Assert.Equal(TestSettings.All.Smoke.Dispersion.VisibilityClassesM.Length, Plume.Visibility(1e7).Class);
    }

    [Fact]
    public void The_atmosphere_is_stable_on_calm_nights_and_unstable_on_calm_days()
    {
        var (day, _) = Burning(); var (night, _) = Burning(start: DateTimeOffset.Parse("2026-08-17T23:00:00Z"));
        Assert.Equal("unstable", Plume.Stability(day, 1, 0));
        Assert.Equal("neutral", Plume.Stability(day, 8, 0));
        Assert.Equal("stable", Plume.Stability(night, 1, 0));
        Assert.True(Plume.MixingHeightM("stable") < Plume.MixingHeightM("neutral"));
    }

    [Fact]
    public void The_field_matches_point_queries_and_is_zero_far_from_the_fire()
    {
        var (run, wind) = Burning();
        int cols = (int)Math.Ceiling(N * Spec.CellM / TestSettings.All.Smoke.Dispersion.FieldBlockM);
        var puffs = Plume.Puffs(run, Burn, wind, 40); string stability = Plume.Stability(run, wind.SpeedMs(40), 40);
        var field = Plume.Field(puffs, stability, cols, cols, TestSettings.All.Smoke.Dispersion.FieldBlockM);
        double block = TestSettings.All.Smoke.Dispersion.FieldBlockM;
        double point = Plume.GroundConcentration(puffs, stability, 30.5 * block, 20.5 * block);
        Assert.Equal(point, field[20 * cols + 30], 6);
        Assert.Equal(0, field[0], 3);
    }

    [Fact]
    public void The_series_says_when_it_is_unsafe_and_when_it_is_safe_again()
    {
        SmokeSample At(int t, double vis) => new(t, 0, vis, 0, vis >= TestSettings.All.Rules.Safety.MinGroundVisibilityM, true);
        var series = SmokeService.Series(new SmokePointRef("p", new LatLon(41.4, -8.3)), new[] { At(0, 5000), At(10, 50), At(20, 80), At(30, 4000), At(40, 5000) });
        Assert.True(series.SafeAtStart);
        Assert.Equal(10, series.UnsafeFromMin); Assert.Equal(30, series.SafeAgainAtMin); Assert.Equal(50, series.MinVisibilityM);
        var never = SmokeService.Series(new SmokePointRef("q", null), new[] { At(0, 50), At(10, 40) });
        Assert.False(never.SafeAtStart); Assert.Null(never.SafeAgainAtMin);
        var clean = SmokeService.Series(new SmokePointRef("r", null), new[] { At(0, 9000), At(10, 9000) });
        Assert.Null(clean.UnsafeFromMin); Assert.Null(clean.SafeAgainAtMin);
    }
}
