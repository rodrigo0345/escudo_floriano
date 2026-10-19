using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record OriginAccess(string StationId, double? Minutes, bool Reachable);
