namespace FireTrace.ExternalData.Weather;

/// <summary>One hour of real weather from a third-party provider. <see cref="Provider"/> says where it came from (`open-meteo-archive` = ERA5 reanalysis, `open-meteo-forecast` = forecast).</summary>
public sealed record HourlyWeather(DateTimeOffset Time, double WindKmh, double WindFromDeg, double HumidityPct, double TempC, string Provider,
    double GustKmh = 0, double PrecipitationMmH = 0);
