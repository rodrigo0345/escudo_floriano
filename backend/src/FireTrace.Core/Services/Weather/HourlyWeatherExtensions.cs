using FireTrace.Core.Domain.Weather;
using FireTrace.ExternalData.Weather;

namespace FireTrace.Core.Services.Weather;

public static class HourlyWeatherExtensions
{
    /// <summary>A provider hour as an API weather sample, labelled `reanalysis` (ERA5 archive) or `forecast`.</summary>
    public static WeatherSample ToSample(this HourlyWeather hour) => new()
    {
        Time = hour.Time, WindKmh = hour.WindKmh, WindFromDeg = hour.WindFromDeg, HumidityPct = hour.HumidityPct, TempC = hour.TempC,
        Source = hour.Provider.EndsWith("archive", StringComparison.Ordinal) ? "reanalysis" : "forecast",
    };
}
