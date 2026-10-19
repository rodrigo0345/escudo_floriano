namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>NDVI de inverno e de verão por píxel da grelha WorldCover; NaN onde não há dados.</summary>
public sealed record PhenologyNdvi(float[] Winter, float[] Summer);
