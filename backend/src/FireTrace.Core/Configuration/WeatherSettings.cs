namespace FireTrace.Core.Configuration;

/// <summary>How a simulation's weather is assembled. The third-party provider (Open-Meteo) is configured in the ExternalData project.</summary>
public sealed record WeatherSettings(WeatherTimelineSettings Timeline);
