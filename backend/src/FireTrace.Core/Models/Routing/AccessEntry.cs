using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record AccessEntry(string PlaceId, string Name, BestOrigin Best, IReadOnlyList<OriginAccess> ByOrigin, bool Isolated);
