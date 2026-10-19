namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>O raster fino de classes de combustível (ids do FuelCatalog) e quantas árvores de cada tipo tem.</summary>
public sealed record SpeciesClassification(byte[] Fine, int Evergreen, int Deciduous, int Conifers);
