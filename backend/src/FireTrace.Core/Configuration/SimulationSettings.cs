namespace FireTrace.Core.Configuration;

public sealed record SimulationSettings(int IgnitionSnapRadiusCells, int WeatherSampleIntervalMinutes, int WaitPollMilliseconds, int WorkerStartPollMilliseconds, ProgressPercent ProgressPercent);
