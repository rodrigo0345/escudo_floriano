namespace FireTrace.ExternalData.Weather;

/// <summary>
/// One hour of real weather from a third-party provider. <see cref="Provider"/> says where it came from (`open-meteo-archive` = ERA5 reanalysis, `open-meteo-forecast` = forecast).
/// Wind is the mean at 10 m (km/h) and where it blows from (°); humidity and temperature are relative humidity (%) and °C. When the provider gives them: gust (km/h), precipitation (mm/h), cloud cover (%), visibility (m), CAPE (J/kg) and whether the sun is up.
/// </summary>
public sealed record HourlyWeather(DateTimeOffset Time, double WindKmh, double WindFromDeg, double HumidityPct, double TempC, string Provider,
    double? GustKmh = null, double? PrecipitationMmH = null, double? CloudCoverPct = null, double? VisibilityM = null, double? CapeJkg = null, bool? IsDay = null);
