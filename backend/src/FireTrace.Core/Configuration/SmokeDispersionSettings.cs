namespace FireTrace.Core.Configuration;

/// <summary>
/// Dispersão do fumo por nuvens gaussianas (puffs): emissão pela intensidade da frente, subida da coluna, deriva com o vento, difusão de Briggs,
/// camada de mistura e visibilidade pela extinção da luz (Koschmieder). Concentrações em µg/m³ de partículas finas.
/// </summary>
public sealed record SmokeDispersionSettings(double FieldBlockM, int PuffStepMinutes, int PuffLifetimeMinutes, int FlameMinutes, double HeatOfCombustionKjKg, double EmissionFactorGPerKg,
    double LowLevelFraction, double SourceSigmaM, double SourceSigmaZRatio, double CalmDiffusionMs, double AloftWindFactor, double MixingHeightDayM, double MixingHeightNightM,
    double MixedLayerSigmaRatio, double MassExtinctionM2g, double ClearVisibilityM, double[] VisibilityClassesM, int QueryDefaultStepMinutes, int MaxQueryPoints, int RoadSamplePoints,
    SmokeStabilitySettings Stability, Dictionary<string, BriggsClass> Briggs);
