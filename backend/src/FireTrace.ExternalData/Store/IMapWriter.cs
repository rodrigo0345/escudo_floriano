using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Store;

/// <summary>Escrita dos dados do mapa (o que o ingest usa). Cada `Replace*` troca a camada inteira do local, de forma atómica.</summary>
public interface IMapWriter
{
    Task UpsertLocationAsync(LocationDefinition location, CancellationToken ct = default);
    Task SaveGridAsync(string locationId, string layer, GridBlob grid, CancellationToken ct = default);
    Task SaveImageryAsync(ImageryAsset asset, CancellationToken ct = default);
    Task ReplaceRoadsAsync(string locationId, GridSpec spec, IReadOnlyList<RoadEdge> edges, IEnumerable<RoadNode> nodes, CancellationToken ct = default);
    Task ReplaceFacilitiesAsync(string locationId, IEnumerable<Facility> items, CancellationToken ct = default);
    Task ReplacePlacesAsync(string locationId, IEnumerable<Place> items, CancellationToken ct = default);
    Task ReplaceWaterPointsAsync(string locationId, IEnumerable<WaterPoint> items, CancellationToken ct = default);
    Task ReplaceFirebreaksAsync(string locationId, IEnumerable<Firebreak> items, CancellationToken ct = default);
    Task ReplaceWaterwaysAsync(string locationId, IEnumerable<Waterway> items, CancellationToken ct = default);
}
