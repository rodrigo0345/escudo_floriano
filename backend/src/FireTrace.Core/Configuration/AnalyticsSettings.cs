namespace FireTrace.Core.Configuration;

public sealed record AnalyticsSettings(int VectorBlockCells, double VectorMinGradient, double VectorMinSpeedGradient, int VectorMinSamplesPerBlock, double VectorMinDirectionConsistency,
    double HeadTrimFraction, double HeadFraction, double PerimeterSimplifyTolerance, int IntensityWindowMinutes, double SlowAccessFactor, double SlowAccessExtraMinutes, double AtRiskProbability,
    PercentileSetting MemberSamplePercentile);
