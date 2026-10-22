using FireTrace.Core.Domain.Weather;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Weather;

namespace FireTrace.Core.Services.Weather;

public static class HourlyWeatherExtensions
{
    /// <summary>A meteorologia que o motor usa num instante, como amostra da API (só leva os campos que têm valor; o ponto de orvalho e a radiação são calculados pelo servidor).</summary>
    public static WeatherSample ToSample(this WeatherPoint p, DateTimeOffset time, string source) => new()
    {
        Time = time, Source = source, WindKmh = Math.Round(p.WindKmh, 1), WindFromDeg = Math.Round(p.WindFromDeg), TempC = Math.Round(p.TempC, 1), HumidityPct = Math.Round(p.HumidityPct),
        GustKmh = p.GustKmh > 0 ? Math.Round(p.GustKmh, 1) : null, PrecipitationMmH = p.PrecipitationMmH > 0 ? Math.Round(p.PrecipitationMmH, 1) : null,
        CloudCoverPct = Math.Round(p.CloudCoverPct), SolarRadiationWm2 = Math.Round(p.SolarRadiationWm2), DewPointC = Math.Round(Psychrometrics.DewPointC(p.TempC, p.HumidityPct), 1),
        VisibilityM = p.VisibilityM is { } visibility ? Math.Round(visibility) : null, CapeJkg = p.CapeJkg is { } cape ? Math.Round(cape) : null, IsDay = p.IsDay,
    };

    /// <summary>A provider hour as an API weather sample, labelled `reanalysis` (ERA5 archive) or `forecast`.</summary>
    public static WeatherSample ToSample(this HourlyWeather hour) => new()
    {
        Time = hour.Time, WindKmh = hour.WindKmh, WindFromDeg = hour.WindFromDeg, HumidityPct = hour.HumidityPct, TempC = hour.TempC,
        GustKmh = hour.GustKmh > 0 ? hour.GustKmh : null, PrecipitationMmH = hour.PrecipitationMmH > 0 ? hour.PrecipitationMmH : null, CloudCoverPct = hour.CloudCoverPct,
        VisibilityM = hour.VisibilityM, CapeJkg = hour.CapeJkg, IsDay = hour.IsDay,
        Source = hour.Provider.EndsWith("archive", StringComparison.Ordinal) ? "reanalysis" : "forecast",
    };
}
