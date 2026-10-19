namespace FireTrace.Core.Configuration;

public sealed record LandscapeSettings(double HouseFootprintM2, double FirebreakFactor, double DenseBuiltThreshold, double BuiltAreaSpreadSlowdown, double MinAdjustmentFactor, int UrbanFuelModel,
    int MinFlammableFuelModel, double SpreadCalibration, SpreadVariabilitySettings SpreadVariability, RiparianSettings Riparian, BarrierSettings Barriers);
