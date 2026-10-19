using FireTrace.Engine.Configuration;

namespace FireTrace.Engine.Elmfire;

/// <summary>Where the ELMFIRE container lives and which folder is shared with it, plus the engine settings it needs.</summary>
public sealed record ElmfireOptions(string JobsDir, string EngineUrl, int MetIntervalSeconds, int HttpTimeoutMinutes, int HealthTimeoutSeconds, int ProgressPollSeconds, SpottingSettings Spotting);
