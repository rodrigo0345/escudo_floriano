namespace FireTrace.ExternalData.Configuration;

public sealed record WaterOptions(double TruckReachM, double HelicopterMinAreaM2, double MaxRoadLinkM, double MinPoolAreaM2, double MinWaterBodyAreaM2, double ReservoirMinAreaM2,
    double BoundsAreaFactor, double PoolDepthM, double PondDepthM, double ReservoirDepthM, double TankVolumeLitresThreshold);
