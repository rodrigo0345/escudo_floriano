using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record BestOrigin(string? StationId, string? OrganizationType, double? Minutes);
