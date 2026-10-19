using FireTrace.Core.Domain.Errors;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record RoutePlan(bool Found, double? DistanceM = null, double? DurationMin = null, LineString? Geometry = null, IReadOnlyList<string>? RoadIds = null,
    IReadOnlyList<BlockedRoad>? BlockedBy = null, IReadOnlyList<ValidationIssue>? Warnings = null);
