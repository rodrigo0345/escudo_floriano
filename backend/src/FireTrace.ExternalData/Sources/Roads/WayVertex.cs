namespace FireTrace.ExternalData.Sources.Roads;

/// <summary>Um nó de uma via OSM, em coordenadas de célula.</summary>
public readonly record struct WayVertex(long Id, double X, double Y);
