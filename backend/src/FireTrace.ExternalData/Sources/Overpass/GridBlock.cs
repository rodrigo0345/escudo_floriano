using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Overpass;

/// <summary>Um dos blocos quadrados em que um local se divide para os pedidos ao Overpass.</summary>
public sealed record GridBlock(int Index, int Total, GeoBounds Box);
