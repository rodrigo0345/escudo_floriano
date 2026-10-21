namespace FireTrace.Engine.Configuration;

/// <summary>
/// The knobs of the native Rothermel engine. The physics itself is in <c>Native/RothermelSurfaceFire.cs</c>; these are the calibration and the thresholds
/// that are site- or policy-specific: how much the modelled spread is calibrated for Portugal, the canopy shelter floor, the aspect drying swing,
/// the Van Wagner crown-fire parameters, the rain thresholds and how much of a gust reaches the flame.
/// </summary>
public sealed record NativeEngineSettings(
    double SpreadCalibration,
    double MinWindAdjustmentFactor,
    int BehaviorBucketMinutes,
    double AspectMoistureSwingPct,
    double MaxLengthToWidthRatio,
    double MinCrownCoverPct,
    double CrownFireRosFactor,
    double CriticalCrownRosFactor,
    double CrownHeatContentKjKg,
    double PassiveCrownFuelFraction,
    double DefaultFoliarMoisturePct,
    double RainStartMmH,
    double RainExtinctionMmH,
    double GustFactor);
