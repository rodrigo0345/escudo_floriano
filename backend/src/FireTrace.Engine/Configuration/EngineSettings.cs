namespace FireTrace.Engine.Configuration;

public sealed record EngineSettings(string Url, int MetIntervalSeconds, int HttpTimeoutMinutes, int HealthTimeoutSeconds, int ProgressPollSeconds, string Provider, SpottingSettings Spotting);
