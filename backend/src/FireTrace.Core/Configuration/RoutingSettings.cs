namespace FireTrace.Core.Configuration;

public sealed record RoutingSettings(Dictionary<string, double> RoadTypicalSpeedKmh, double UnknownRoadSpeedKmh, int MaxReroutes, double DefaultBufferM, int RoadStatusWarningMinutes,
    double AerialDefaultKmh, string[] OffRoadVehicleTypes,
    double MaxSnapM, double WalkKmh, double RouteToleranceM, double PositionToleranceM);
