namespace FireTrace.Core.Configuration;

public sealed record RoutingSettings(Dictionary<string, double> RoadTypicalSpeedKmh, double UnknownRoadSpeedKmh, int MaxReroutes, double DefaultBufferM, int RoadStatusWarningMinutes,
    double AerialDefaultKmh, string[] OffRoadVehicleTypes,
    double MaxSnapM, double WalkKmh, double RouteToleranceM, double PositionToleranceM,
    Dictionary<string, double> TrackTypeSpeedKmh, Dictionary<string, double> UnpavedVehicleFactor, Dictionary<string, double> IntersectionDelaySeconds,
    double LateralAccelMps2, double MinCurveSpeedKmh, double CurveMinSegmentM, double HeavyVehicleWeightT, Dictionary<string, double> HeavyVehicleMaxKmh);
