using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record AccessOrigin(string? StationId = null, LatLon? Position = null);
