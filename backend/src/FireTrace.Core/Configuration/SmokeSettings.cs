namespace FireTrace.Core.Configuration;

public sealed record SmokeSettings(int BlockCells, double PlumeBaseHeightM, double PlumeHeightPerSqrtKwm, double PlumeReferenceKwm, double CrownHeightFactor, double DriftHours, double MinDriftKm,
    double MaxDriftKm, double DriftSpeedFactor, double CorridorWidthM, int MaxAffectedRoads, SmokeDispersionSettings Dispersion);
