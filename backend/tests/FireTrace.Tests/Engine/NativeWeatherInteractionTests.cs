using FireTrace.Core.Common;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Services.Fire;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Native;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Engine;

/// <summary>
/// The weather and fuel interactions the native engine must show: rain wets the fuel and can extinguish the front, gusts drive runs, hot dry air dries
/// the fine fuel, and live moisture (green grass, wet shrubs) slows the fire. Each test changes one variable on the same 40×40 pasture.
/// </summary>
public class NativeWeatherInteractionTests
{
    const int N = 40;
    static readonly GridSpec Spec = new(41.4, -8.3, N, N, 60);
    static readonly NativeFireEngine Engine = new(TestSettings.All.NativeEngine, TestSettings.All.FuelMoisture, Environment.ProcessorCount);

    static WeatherTrack Track(double wind = 20, double gust = 0, double precip = 0, double temp = 30, double humidity = 25) =>
        new(new[] { new WeatherPoint(0, wind, 270, humidity, temp, gust, precip) });

    static async Task<int> Burn(WeatherTrack track, FuelMoistureSpec? moisture = null)
    {
        var terrain = new TerrainGrids(Spec, new float[N * N], Enumerable.Repeat(LandCover.Pasto, N * N).ToArray(), new ushort[N * N]);
        var landscape = TestSettings.FlatLandscape;
        var adjustment = landscape.Adjustment(terrain, Array.Empty<Firebreak>(), Array.Empty<Waterway>());
        var bands = landscape.Bands(terrain);
        var job = new FireJob(Spec.ToEngineGrid(), bands, adjustment, new[] { new IgnitionCell(10, 20) }, 60,
            new[] { new MemberWeather("rep", track) }, 0, Spotting: false, FuelMoisture: moisture);
        var result = (await Engine.RunAsync(job))["rep"];
        return result.Ignition.Count(t => t >= 0);
    }

    [Fact]
    public async Task Rain_slows_the_fire_and_heavy_rain_extinguishes_it()
    {
        var dry = await Burn(Track());
        var drizzle = await Burn(Track(precip: 2));
        var downpour = await Burn(Track(precip: 6));
        Assert.True(drizzle < dry, $"chuva fraca {drizzle} vs seco {dry}");
        Assert.True(downpour <= 1, $"chuva forte devia ficar na ignição, ficou em {downpour} células");
    }

    [Fact]
    public async Task Gusts_push_the_fire_further_than_the_mean_wind()
    {
        var steady = await Burn(Track(wind: 8, gust: 8));
        var gusty = await Burn(Track(wind: 8, gust: 35));
        Assert.True(gusty > steady, $"rajada {gusty} vs estável {steady}");
    }

    [Fact]
    public async Task Hot_dry_air_burns_more_than_cool_humid_air()
    {
        var dry = await Burn(Track(temp: 35, humidity: 15));
        var humid = await Burn(Track(temp: 15, humidity: 80));
        Assert.True(dry > humid, $"quente/seco {dry} vs fresco/húmido {humid}");
    }

    [Fact]
    public async Task Green_grass_and_wet_live_shrubs_slow_the_fire()
    {
        var cured = new FuelMoistureSpec("fixed", new FuelMoisture(Dead1hPct: 6, Dead10hPct: 8, Dead100hPct: 10, LiveHerbaceousPct: 30, LiveWoodyPct: 60));
        var green = new FuelMoistureSpec("fixed", cured.Values! with { LiveHerbaceousPct = 200, LiveWoodyPct = 180 });
        var fast = await Burn(Track(), cured);
        var slow = await Burn(Track(), green);
        Assert.True(fast > slow, $"combustível curado {fast} vs verde/húmido {slow}");
    }
}
