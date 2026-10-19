using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Store;

/// <summary>Leitura dos dados do mapa (o que a API usa). Todos os métodos são por id de local.</summary>
public interface IMapReader
{
    LocationCatalog Locations { get; }
    string DataDir { get; }

    Task<TerrainGrids> GetTerrainAsync(string locationId, CancellationToken ct = default);
    Task<RenderHeightmap?> GetRenderHeightmapAsync(string locationId, CancellationToken ct = default);
    Task<RoadNetwork> GetRoadsAsync(string locationId, CancellationToken ct = default);
    Task<IReadOnlyList<Place>> GetPlacesAsync(string locationId, CancellationToken ct = default);
    Task<IReadOnlyList<Facility>> GetFacilitiesAsync(string locationId, CancellationToken ct = default);
    Task<IReadOnlyList<WaterPoint>> GetWaterPointsAsync(string locationId, CancellationToken ct = default);
    Task<IReadOnlyList<Firebreak>> GetFirebreaksAsync(string locationId, CancellationToken ct = default);
    Task<IReadOnlyList<Waterway>> GetWaterwaysAsync(string locationId, CancellationToken ct = default);
    Task<IReadOnlyList<ImageryAsset>> GetImageryAsync(string locationId, CancellationToken ct = default);
}
