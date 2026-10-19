using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>O mapa de vegetação: a classe por célula da grelha, o método que o produziu e o raster fino (<paramref name="FineWidth"/> × <paramref name="FineHeight"/>, sobre <paramref name="Extent"/>) de onde vem.</summary>
public sealed record SpeciesMap(byte[] Cover, string Method, byte[] Fine, int FineWidth, int FineHeight, GeoBounds Extent);
