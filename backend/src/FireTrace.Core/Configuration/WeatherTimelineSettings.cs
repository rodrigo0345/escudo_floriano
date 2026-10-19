namespace FireTrace.Core.Configuration;

public sealed record WeatherTimelineSettings(int StepMinutes, int MarginMinutes, int ProviderPaddingBeforeHours, int ProviderPaddingAfterHours, WeatherFallback ProviderFallback, WeatherNoneBase NoneBase,
    double MinHumidityPct, double MaxHumidityPct, double RainSaturationHumidityPct);
