namespace FireTrace.Engine.Configuration;

public sealed record NativeEngineSettings(double ReferenceRosMPerMin, double WindCoefficientA, double WindCoefficientB, double SlopeCoefficient,
    double MoistureDampingK, double MinEllipseRatio, double MaxEllipseRatio, double EllipseWindRefKmh, double FirelineIntensityFactor,
    double CrownFireIntensityThresholdKwm, double CrownFuelLoadFactor, double CanopyWindShelterFactor, double AspectMoistureSwingPct,
    double CrownFireRosBoost, double CrownFireReferenceBulkDensity);
