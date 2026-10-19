using System.Text.Json.Serialization;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record WaterPointView(string Id, string Kind, string Name, LatLon Position, string? Ref, double? CapacityL, bool CapacityEstimated, double? FlowLpm, double? AreaM2,
    double? DiameterMm, string? HydrantType, bool TruckAccessible, bool HelicopterAccessible, string? NearestRoadId, double? RoadDistanceM, string Access, string Source, string? OsmId, bool Available = true);
