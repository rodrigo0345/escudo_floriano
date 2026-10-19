using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Uma janela do raster WorldCover (códigos ESA, linha a linha, norte primeiro) com a sua extensão geográfica exata.</summary>
public sealed record WorldCoverWindow(byte[] Data, int Width, int Height, GeoBounds Extent);
