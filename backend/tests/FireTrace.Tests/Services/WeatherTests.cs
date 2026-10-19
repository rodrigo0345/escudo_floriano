using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Services.Weather;
using FireTrace.Engine.Weather;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

public class WeatherTests
{
    [Fact]
    public void Track_interpolates_and_the_wind_direction_turns_the_short_way()
    {
        var track = new WeatherTrack(new[] { new WeatherPoint(0, 10, 350, 40, 20), new WeatherPoint(60, 30, 10, 20, 30) });
        var mid = track.At(30);
        Assert.Equal(20, mid.WindKmh, 0);
        Assert.True(mid.WindFromDeg > 340 || mid.WindFromDeg < 20); // passa por norte, não por sul
        Assert.Equal(30, mid.HumidityPct, 3);
        Assert.Equal(30, track.At(500).WindKmh, 3); // depois da série mantém o último valor
    }

    [Fact]
    public void Timeline_without_provider_follows_the_keyframes_and_events()
    {
        var start = DateTimeOffset.Parse("2026-08-17T15:00:00Z");
        var spec = new WeatherSpec
        {
            Base = WeatherBase.None, SpinUpHours = 1,
            Keyframes = new()
            {
                new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 0), WindKmh = 10, WindFromDeg = 270, TempC = 30, HumidityPct = 30 },
                new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 60), WindKmh = 30, WindFromDeg = 270, TempC = 30, HumidityPct = 30 },
            },
            Events = new() { new WindScaleEvent { Window = new TimeWindow(new TimeSpec(OffsetMinutes: 90), new TimeSpec(OffsetMinutes: 120)), Factor = 0.5 } },
        };
        var track = WeatherTimeline.Build(spec, Array.Empty<WeatherSample>(), start, 180, TestSettings.All.Weather.Timeline, 1);
        Assert.Equal(20, track.At(30).WindKmh, 0);
        Assert.Equal(30, track.At(60).WindKmh, 0);
        Assert.Equal(15, track.At(100).WindKmh, 0); // evento a reduzir o vento a metade
        Assert.Equal(30, track.At(150).WindKmh, 0);
    }

    [Fact]
    public void Dead_fuel_moisture_has_inertia()
    {
        // 8 h secas (HR 20%) e depois muito húmido (HR 95%): o combustível fino segue depressa, o grosso quase não se mexe
        var points = Enumerable.Range(-8, 20).Select(h => new WeatherPoint(h * 60, 10, 270, h < 0 ? 20 : 95, 25));
        var rows = DeadFuelMoisture.Series(new WeatherTrack(points), 600, 13, TestSettings.All.FuelMoisture, 420); // 0 .. 2 h
        Assert.True(rows[^1].M1 > rows[0].M1 + 3);   // 1 h reage
        Assert.True(rows[^1].M100 < rows[^1].M1);    // 100 h reage muito menos
        Assert.All(rows, r => Assert.InRange(r.M1, 2, 40));
        Assert.Equal(13, rows.Count);
    }
}
