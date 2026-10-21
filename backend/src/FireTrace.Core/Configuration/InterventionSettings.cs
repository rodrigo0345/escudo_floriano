namespace FireTrace.Core.Configuration;

public sealed record InterventionSettings(double MinSpreadFactor, double AerialLineBufferM, int AerialDefaultEffectMinutes, double FireLineRateMPerHourPerPerson, double StructureProtectionRadiusM, FuelRemovalSettings FuelRemoval,
    double LineHoldFullKwm = 3500, double LineBreachKwm = 10000);
