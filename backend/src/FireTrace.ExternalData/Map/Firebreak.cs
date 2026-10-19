using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Map;

public sealed record Firebreak(long Id, FirebreakKind Kind, string? Name, double? WidthM, bool Maintained, string Source, Geometry Geometry);
