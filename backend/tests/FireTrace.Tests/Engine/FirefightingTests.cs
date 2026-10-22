using FireTrace.Core.Common;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Services.Operations;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Native;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Engine;

/// <summary>A luta contra o fogo: o fogo só abranda onde e quando há gente a combater, e as chamas muito intensas deixam de se poder combater.</summary>
public class FirefightingTests
{
    const int N = 60, IgnitionX = 10, IgnitionY = 30, Column = 16;
    static readonly GridSpec Spec = new(41.4, -8.3, N, N, 60);
    static readonly NativeFireEngine Engine = new(TestSettings.All.NativeEngine, TestSettings.All.FuelMoisture, Environment.ProcessorCount);

    static int[] LineAtColumn() => Enumerable.Range(0, N).Select(y => y * N + Column).ToArray();

    /// <summary>Minuto em que o fogo chega à coluna 24 (bem para lá da linha de combate), ou -1.</summary>
    static async Task<int> ArrivalBeyond(SuppressionPlan? plan, double windKmh = 25)
    {
        var land = new byte[N * N]; Array.Fill(land, LandCover.Pasto);
        var terrain = new TerrainGrids(Spec, new float[N * N], land, new ushort[N * N]);
        var landscape = TestSettings.FlatLandscape;
        var adjustment = landscape.Adjustment(terrain, Array.Empty<Firebreak>(), Array.Empty<Waterway>());
        var member = new MemberWeather("rep", WeatherTrack.Constant(windKmh, 270, 25), adjustment);
        var job = new FireJob(Spec.ToEngineGrid(), landscape.Bands(terrain), adjustment, new[] { new IgnitionCell(IgnitionX, IgnitionY) }, 120, new[] { member }, 0, Spotting: false, Suppression: plan);
        return (await Engine.RunAsync(job))["rep"].Ignition[IgnitionY * N + 24];
    }

    static SuppressionPlan Plan(double effectiveness, float from, float until, double fullKwm = 1_000_000, double noneKwm = 2_000_000, bool direct = true) =>
        new(new[] { new SuppressionWindow(LineAtColumn(), from, until, (float)effectiveness, direct) }, fullKwm, noneKwm, 0.02);

    [Fact]
    public async Task A_crew_working_across_the_fires_path_slows_it()
    {
        int free = await ArrivalBeyond(null);
        int held = await ArrivalBeyond(Plan(0.8, 0, float.MaxValue));
        Assert.True(free > 0);
        Assert.True(held < 0 || held > free + 10, $"free {free} held {held}");
    }

    static SuppressionPlan Crews(int count, double effectiveness, double extinguishAt, double fullKwm = 1_000_000, double noneKwm = 2_000_000) =>
        new(Enumerable.Range(0, count).Select(_ => new SuppressionWindow(LineAtColumn(), 0, float.MaxValue, (float)effectiveness)).ToArray(), fullKwm, noneKwm, 0.02, ExtinguishAt: extinguishAt);

    [Fact]
    public async Task Enough_crews_on_flames_they_can_fight_put_the_fire_out_where_fewer_only_slow_it()
    {
        int free = await ArrivalBeyond(null);
        Assert.True(free > 0);
        Assert.True(await ArrivalBeyond(Crews(1, 0.4, 0.65)) > free);   // one vehicle (~40%) only slows it
        Assert.Equal(-1, await ArrivalBeyond(Crews(3, 0.4, 0.65)));     // three together (78%) stop it
        Assert.True(await ArrivalBeyond(Crews(3, 0.4, 2)) is > 0);      // with the rule off they only slow it
    }

    [Fact]
    public async Task Flames_too_intense_to_fight_are_not_put_out_however_many_crews_there_are()
    {
        int free = await ArrivalBeyond(null);
        Assert.Equal(free, await ArrivalBeyond(Crews(6, 0.4, 0.65, fullKwm: 0, noneKwm: 1)));
    }

    [Fact]
    public async Task A_crew_that_has_left_or_not_yet_arrived_does_nothing()
    {
        int free = await ArrivalBeyond(null);
        Assert.Equal(free, await ArrivalBeyond(Plan(0.8, 0, 2)));        // saiu antes de o fogo chegar à coluna
        Assert.Equal(free, await ArrivalBeyond(Plan(0.8, 110, 120)));    // só chega depois de o fogo já ter passado
    }

    [Fact]
    public async Task Direct_attack_fails_against_flames_too_intense_to_fight_but_a_finished_line_does_not()
    {
        int free = await ArrivalBeyond(null);
        Assert.Equal(free, await ArrivalBeyond(Plan(0.8, 0, float.MaxValue, fullKwm: 0, noneKwm: 1)));              // chamas "impossíveis": o ataque direto não trava
        Assert.NotEqual(free, await ArrivalBeyond(Plan(0.8, 0, float.MaxValue, fullKwm: 0, noneKwm: 1, direct: false))); // uma linha pronta trava na mesma
    }

    [Fact]
    public void A_crew_with_water_works_in_stints_and_goes_to_refill_in_between()
    {
        var rules = TestSettings.All.Rules;
        var segments = CrewWorkSchedule.Plan(arrival: 20, until: 120, waterL: 3500, pumpLpm: 1500, rules);
        Assert.True(segments.Count > 1);
        Assert.Equal(20, segments[0].FromMinute);
        double stint = 3500 / rules.Water.WorkingLpm(1500); // as linhas de ataque, não o caudal todo da bomba
        Assert.Equal(stint, segments[0].Minutes, 3);
        Assert.Equal(segments[0].FromMinute + stint + rules.Water.Refill.ShuttleMinutes + rules.Water.Refill.SetupMinutes, segments[1].FromMinute, 3); // o intervalo de reabastecimento
        Assert.True(segments[1].Fatigue < segments[0].Fatigue);                                                                                       // cansa-se
    }

    [Fact]
    public void A_crew_without_water_works_without_refill_breaks_but_rests_after_the_continuous_limit()
    {
        var rules = TestSettings.All.Rules;
        var segments = CrewWorkSchedule.Plan(0, 600, waterL: 0, pumpLpm: 0, rules);
        Assert.Equal(rules.Crews.MaxContinuousWorkMinutes, segments[0].Minutes);
        Assert.Equal(rules.Crews.MaxContinuousWorkMinutes + rules.Crews.MandatoryRestMinutes, segments[1].FromMinute);
        Assert.True(segments.All(s => s.Fatigue >= rules.Crews.MinimumEffectivenessPct / 100 - 1e-9));
    }

    [Fact]
    public async Task A_line_only_holds_once_it_is_built_so_a_line_finished_after_the_fire_passed_changes_nothing()
    {
        int free = await ArrivalBeyond(null);
        Assert.NotEqual(free, await ArrivalBeyond(Plan(0.9, 0, float.MaxValue, direct: false)));  // pronta desde o início: trava
        Assert.Equal(free, await ArrivalBeyond(Plan(0.9, 100, float.MaxValue, direct: false)));   // pronta aos 100 min, já o fogo passou
    }
}
