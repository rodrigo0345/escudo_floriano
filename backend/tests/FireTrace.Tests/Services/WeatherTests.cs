using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Services.Weather;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
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
        var track = WeatherTimeline.Build(spec, Array.Empty<WeatherSample>(), start, 180, TestSettings.All.Weather.Timeline, 1, new LatLon(41.4, -8.3));
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

    static WeatherTrack Steady(double rainMmH = 0, double solarWm2 = 0, double cloudPct = 0) =>
        new(Enumerable.Range(-8, 20).Select(h => new WeatherPoint(h * 60, 10, 270, 30, 28, 0, h >= -1 ? rainMmH : 0, cloudPct, solarWm2))); // a chuva só nas duas últimas horas

    [Fact]
    public void Rain_wets_dead_fuel_fast_for_fine_and_slowly_for_coarse_even_at_the_same_air_humidity()
    {
        var dry = DeadFuelMoisture.Series(Steady(), 600, 7, TestSettings.All.FuelMoisture, 420);
        var wet = DeadFuelMoisture.Series(Steady(rainMmH: 3), 600, 7, TestSettings.All.FuelMoisture, 420);
        Assert.True(wet[^1].M1 > dry[^1].M1 + 10);                            // 3 mm/h durante horas encharca o combustível fino
        Assert.True(wet[^1].M100 > dry[^1].M100);                              // e o grosso também molha, mas menos
        Assert.True(wet[^1].M1 - dry[^1].M1 > wet[^1].M100 - dry[^1].M100);
        Assert.All(wet, r => Assert.True(r.M1 <= TestSettings.All.FuelMoisture.RainSaturationPct + 0.01));
    }

    [Fact]
    public void Sun_heats_the_fuel_surface_and_dries_it_compared_with_the_same_air_at_night()
    {
        var night = DeadFuelMoisture.Series(Steady(), 600, 7, TestSettings.All.FuelMoisture, 420);
        var noon = DeadFuelMoisture.Series(Steady(solarWm2: 900), 600, 7, TestSettings.All.FuelMoisture, 420);
        Assert.True(noon[^1].M1 < night[^1].M1);
        Assert.True(Psychrometrics.SurfaceHumidityPct(30, 28, 36) < 30);       // a mesma água no ar, numa superfície mais quente, dá menos humidade relativa
        Assert.Equal(25, Psychrometrics.DewPointC(25, 100), 1);                // ar saturado: o orvalho é a temperatura do ar
    }

    [Fact]
    public void Solar_radiation_follows_the_sun_and_the_clouds()
    {
        var noon = DateTimeOffset.Parse("2026-08-17T12:30:00Z"); // ~meio-dia solar em Guimarães
        double clear = SolarRadiation.ClearSkyWm2(41.4, -8.3, noon);
        Assert.InRange(clear, 800, 1050);
        Assert.Equal(0, SolarRadiation.ClearSkyWm2(41.4, -8.3, DateTimeOffset.Parse("2026-08-17T01:00:00Z")));
        Assert.True(SolarRadiation.ClearSkyWm2(41.4, -8.3, DateTimeOffset.Parse("2026-12-21T12:30:00Z")) < clear * 0.6); // o sol de inverno é bem mais fraco
        Assert.Equal(clear, SolarRadiation.Wm2(41.4, -8.3, noon, 0), 3);
        Assert.InRange(SolarRadiation.Wm2(41.4, -8.3, noon, 100), clear * 0.2, clear * 0.3); // encoberto deixa passar um quarto
    }

    [Fact]
    public void Timeline_carries_the_providers_gusts_rain_and_cloud_and_rain_events_cover_the_sky()
    {
        var start = DateTimeOffset.Parse("2026-08-17T12:00:00Z");
        var hourly = Enumerable.Range(-3, 8).Select(h => new WeatherSample
        {
            Time = start.AddHours(h), WindKmh = 10, WindFromDeg = 270, TempC = 25, HumidityPct = 40, GustKmh = 35, PrecipitationMmH = h == 1 ? 2 : 0, CloudCoverPct = 20,
        }).ToList();
        var spec = new WeatherSpec
        {
            Base = WeatherBase.Provider, SpinUpHours = 1,
            Events = new() { new PrecipitationEvent { Window = new TimeWindow(new TimeSpec(OffsetMinutes: 120), new TimeSpec(OffsetMinutes: 150)), IntensityMmH = 5 } },
        };
        var track = WeatherTimeline.Build(spec, hourly, start, 180, TestSettings.All.Weather.Timeline, 1, new LatLon(41.4, -8.3));
        Assert.Equal(35, track.At(0).GustKmh, 0);                  // a rajada do fornecedor passa para a série
        Assert.Equal(2, track.At(60).PrecipitationMmH, 1);         // e a chuva da hora
        Assert.Equal(20, track.At(0).CloudCoverPct, 0);
        Assert.True(track.At(0).SolarRadiationWm2 > 400);          // meio-dia de agosto, nuvens a 20 %
        Assert.True(track.At(135).CloudCoverPct > 80);             // o evento de chuva cobre o céu
        Assert.True(track.At(135).SolarRadiationWm2 < track.At(0).SolarRadiationWm2 * 0.5);
    }

    [Fact]
    public void Cloud_cover_can_be_set_by_keyframes()
    {
        var start = DateTimeOffset.Parse("2026-08-17T12:00:00Z");
        var spec = new WeatherSpec
        {
            Base = WeatherBase.None, SpinUpHours = 1,
            Keyframes = new() { new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 0), WindKmh = 10, WindFromDeg = 270, TempC = 30, HumidityPct = 30, CloudCoverPct = 0 },
                                new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 60), CloudCoverPct = 100 } },
        };
        var track = WeatherTimeline.Build(spec, Array.Empty<WeatherSample>(), start, 120, TestSettings.All.Weather.Timeline, 1, new LatLon(41.4, -8.3));
        Assert.Equal(0, track.At(0).CloudCoverPct, 0);
        Assert.Equal(50, track.At(30).CloudCoverPct, 0);
        Assert.Equal(100, track.At(90).CloudCoverPct, 0);
    }

    [Fact]
    public void Invented_weather_needs_no_real_data_and_rain_gusts_and_clouds_start_from_zero()
    {
        var start = DateTimeOffset.Parse("2026-08-17T12:00:00Z");
        var spec = new WeatherSpec
        {
            Base = WeatherBase.None, SpinUpHours = 1,
            Keyframes = new() { new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 0), WindKmh = 10, WindFromDeg = 270, TempC = 30, HumidityPct = 30 },
                                new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 90), GustKmh = 60, PrecipitationMmH = 8, CloudCoverPct = 100 } },
        };
        var track = WeatherTimeline.Build(spec, Array.Empty<WeatherSample>(), start, 150, TestSettings.All.Weather.Timeline, 1, new LatLon(41.4, -8.3));
        Assert.Equal(0, track.At(0).PrecipitationMmH, 3);
        Assert.Equal(0, track.At(60).GustKmh, 3);
        Assert.Equal(0, track.At(60).CloudCoverPct, 3);
        Assert.Equal(8, track.At(120).PrecipitationMmH, 3);
        Assert.Equal(10, track.At(0).WindKmh, 3); // o vento sem mais pontos mantém-se
    }
}
