using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record AccessMatrix(string LocationId, DateTimeOffset? At, IReadOnlyList<AccessEntry> Entries);
