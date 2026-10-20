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
    public void Manual_keyframes_carry_gusts_and_rain_without_a_provider()
    {
        var start = DateTimeOffset.Parse("2026-08-17T15:00:00Z");
        var spec = new WeatherSpec
        {
            Base = WeatherBase.None, SpinUpHours = 0,
            Keyframes = new()
            {
                new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 0), WindKmh = 35, WindFromDeg = 335, GustKmh = 55, TempC = 34, HumidityPct = 18, PrecipitationMmH = 2 },
                new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 60), WindKmh = 35, WindFromDeg = 335, GustKmh = 45, TempC = 31, HumidityPct = 22, PrecipitationMmH = 0 },
            },
        };
        var track = WeatherTimeline.Build(spec, Array.Empty<WeatherSample>(), start, 60, TestSettings.All.Weather.Timeline, 0);
        Assert.Equal(35, track.At(0).WindKmh, 1);
        Assert.Equal(55, track.At(0).GustKmh, 1);
        Assert.Equal(2, track.At(0).PrecipitationMmH, 2);
        Assert.Equal(18, track.At(0).HumidityPct, 1);
        Assert.Equal(50, track.At(30).GustKmh, 1);
        Assert.Equal(1, track.At(30).PrecipitationMmH, 2);
    }

    [Fact]
    public void Custom_series_can_be_the_only_manual_source()
    {
        var start = DateTimeOffset.Parse("2026-08-17T15:00:00Z");
        var spec = new WeatherSpec
        {
            Base = WeatherBase.None, SpinUpHours = 0,
            Events = new()
            {
                new CustomSeriesEvent
                {
                    Samples = new()
                    {
                        new WeatherSample { Time = start, WindKmh = 15, WindFromDeg = 300, GustKmh = 30, TempC = 30, HumidityPct = 30, PrecipitationMmH = 0 },
                        new WeatherSample { Time = start.AddHours(1), WindKmh = 25, WindFromDeg = 310, GustKmh = 45, TempC = 32, HumidityPct = 25, PrecipitationMmH = 1.2 },
                    }
                }
            }
        };
        var track = WeatherTimeline.Build(spec, Array.Empty<WeatherSample>(), start, 60, TestSettings.All.Weather.Timeline, 1);
        Assert.Equal(15, track.At(-60).WindKmh, 1); // a primeira amostra manual também cobre o aquecimento
        Assert.Equal(15, track.At(0).WindKmh, 1);
        Assert.Equal(20, track.At(30).WindKmh, 1);
        Assert.Equal(37.5, track.At(30).GustKmh, 1);
        Assert.Equal(0.6, track.At(30).PrecipitationMmH, 2);
    }

    [Fact]
    public void Timeline_with_provider_keeps_gusts_and_rain_for_the_engine()
    {
        var start = DateTimeOffset.Parse("2026-08-17T15:00:00Z");
        var spec = new WeatherSpec { Base = WeatherBase.Provider, SpinUpHours = 0 };
        var hourly = new List<WeatherSample>
        {
            new() { Time = start, WindKmh = 10, WindFromDeg = 270, HumidityPct = 30, TempC = 25, GustKmh = 35, PrecipitationMmH = 2 },
            new() { Time = start.AddHours(1), WindKmh = 12, WindFromDeg = 270, HumidityPct = 30, TempC = 25, GustKmh = 40, PrecipitationMmH = 3 },
        };
        var track = WeatherTimeline.Build(spec, hourly, start, 60, TestSettings.All.Weather.Timeline, 0);
        Assert.Equal(35, track.At(0).GustKmh, 1);
        Assert.Equal(2, track.At(0).PrecipitationMmH, 1);
        Assert.Equal(37.5, track.At(30).GustKmh, 1);
        Assert.Equal(2.5, track.At(30).PrecipitationMmH, 1);
    }

    [Fact]
    public void Rain_wets_the_dead_fuel_classes()
    {
        var dry = DeadFuelMoisture.Series(new WeatherTrack(new[] { new WeatherPoint(0, 10, 270, 40, 25) }), 60, 61, TestSettings.All.FuelMoisture, 0);
        var wet = DeadFuelMoisture.Series(new WeatherTrack(new[] { new WeatherPoint(0, 10, 270, 40, 25, 0, 4) }), 60, 61, TestSettings.All.FuelMoisture, 0);
        Assert.True(wet[^1].M1 > dry[^1].M1 + 10, $"chuva {wet[^1].M1:F1}% vs seco {dry[^1].M1:F1}%");
        Assert.True(wet[^1].M100 > dry[^1].M100);
    }

    [Fact]
    public void Spin_up_preconditions_the_coarse_fuels()
    {
        var track = new WeatherTrack(new[]
        {
            new WeatherPoint(-120, 10, 270, 90, 15), // as duas horas anteriores são húmidas
            new WeatherPoint(0, 10, 270, 20, 30),    // o fogo começa com ar seco
            new WeatherPoint(60, 10, 270, 20, 30),
        });
        var with = DeadFuelMoisture.Series(track, 60, 2, TestSettings.All.FuelMoisture, 120);
        var without = DeadFuelMoisture.Series(track, 60, 2, TestSettings.All.FuelMoisture, 0);
        Assert.True(with[0].M10 > without[0].M10 + 2, $"10 h {with[0].M10:F1}% vs {without[0].M10:F1}%");
        Assert.True(with[0].M100 > without[0].M100 + 2, $"100 h {with[0].M100:F1}% vs {without[0].M100:F1}%");
    }

    [Fact]
    public void Provider_gusts_and_rain_reach_the_weather_samples()
    {
        var hour = new FireTrace.ExternalData.Weather.HourlyWeather(DateTimeOffset.Parse("2026-08-17T15:00:00Z"), 20, 270, 30, 25, "open-meteo-forecast", 42, 1.5);
        var sample = hour.ToSample();
        Assert.Equal(42, sample.GustKmh);
        Assert.Equal(1.5, sample.PrecipitationMmH);
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
