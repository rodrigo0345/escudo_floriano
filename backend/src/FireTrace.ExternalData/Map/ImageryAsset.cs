namespace FireTrace.ExternalData.Map;

public sealed record ImageryAsset(string LocationId, string Kind, string Source, int Zoom, string Path, GeoBounds Bounds, string Attribution);
