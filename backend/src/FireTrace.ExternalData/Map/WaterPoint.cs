namespace FireTrace.ExternalData.Map;

public sealed record WaterPoint(long Id, WaterPointKind Kind, string Name, double Lat, double Lon, string? Ref, double? CapacityL, bool CapacityEstimated,
    double? FlowLpm, double? AreaM2, double? DiameterMm, string? HydrantType, bool TruckAccessible, bool HelicopterAccessible,
    int? NearestRoadId, double? RoadDistanceM, string Access, string Source, string? OsmId);
