using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Map;

/// <summary>Onde se pode apoiar uma linha de contenção. `Geometry` em WGS84 (linha ou polígono).</summary>
public enum WaterwayKind { River, Canal, Stream, Drain }
