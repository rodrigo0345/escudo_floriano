using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Map;

/// <summary>Curso de água (OSM `waterway=*`) como linha: o leito e a vegetação ribeirinha travam o fogo (ver `LandscapeBuilder`).</summary>
public sealed record Waterway(long Id, WaterwayKind Kind, string? Name, double? WidthM, Geometry Geometry);
