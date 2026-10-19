using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Weather;

/// <summary>Where real weather comes from: an hourly series between two instants for a point. Results are stored locally, so asking again for the same hours does not call the provider.</summary>
public interface IWeatherSource
{
    Task<IReadOnlyList<HourlyWeather>> GetHourlyAsync(string locationId, LatLon point, DateTimeOffset from, DateTimeOffset to, CancellationToken ct = default);
}
