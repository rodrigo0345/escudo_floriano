namespace FireTrace.ExternalData.Map;

/// <summary>Bocas de incêndio e locais onde se pode abastecer água (OSM). `NearestRoadId` e `RoadDistanceM` ligam o ponto à rede viária.</summary>
public enum WaterPointKind { Hydrant, DryHydrant, Tank, Reservoir, Pond, SwimmingPool }
