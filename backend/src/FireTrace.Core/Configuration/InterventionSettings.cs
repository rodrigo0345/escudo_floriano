namespace FireTrace.Core.Configuration;

public sealed record InterventionSettings(double MinSpreadFactor, double AerialLineBufferM, double StructureProtectionRadiusM, FuelRemovalSettings FuelRemoval);
