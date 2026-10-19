using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record BlockedRoad(string RoadId, string Reason, string? ClosureId = null, double? AtMinute = null);
