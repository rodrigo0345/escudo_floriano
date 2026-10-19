using FireTrace.Core.Domain.Resources;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record AccessRequest(string LocationId, List<AccessOrigin>? Origins = null, List<OrganizationType>? OriginTypes = null, List<string>? DestinationPlaceIds = null,
    DateTimeOffset? At = null, string? SimulationId = null, string Percentile = "p50");
