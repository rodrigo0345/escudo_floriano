namespace FireTrace.Core.Configuration;

public sealed record InterventionSettings(double MinSpreadFactor, double AerialLineBufferM, int AerialDefaultEffectMinutes, double FireLineRateMPerHourPerPerson, double StructureProtectionRadiusM, FuelRemovalSettings FuelRemoval);
