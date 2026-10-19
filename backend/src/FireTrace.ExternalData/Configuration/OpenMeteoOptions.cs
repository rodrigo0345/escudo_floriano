namespace FireTrace.ExternalData.Configuration;

/// <summary>The Open-Meteo weather provider: archive (ERA5, lagging a few days) for the past, forecast for the recent days and the future.</summary>
public sealed record OpenMeteoOptions(int HttpTimeoutSeconds, string UserAgent, int Era5ArchiveLagDays, string ArchiveBaseUrl, string ForecastBaseUrl);
