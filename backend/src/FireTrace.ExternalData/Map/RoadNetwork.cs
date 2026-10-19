namespace FireTrace.ExternalData.Map;

public sealed record RoadNetwork(GridSpec Spec, IReadOnlyList<RoadEdge> Edges, IReadOnlyDictionary<string, RoadNode> Nodes);
