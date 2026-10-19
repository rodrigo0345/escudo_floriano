namespace FireTrace.Core.Configuration;

/// <summary>Que classe de estabilidade vale a cada hora solar e vento (m/s): de dia o sol instabiliza a atmosfera, de noite um vento fraco estabiliza-a.</summary>
public sealed record SmokeStabilitySettings(double DayStartHour, double DayEndHour, double UnstableBelowMs, double SlightlyUnstableBelowMs, double NightStableBelowMs);
