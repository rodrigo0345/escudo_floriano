namespace FireTrace.ExternalData.Configuration;

public sealed record PlaceOptions(Dictionary<string, int> DefaultPopulation, double DedupeDegrees, double CuratedDedupeDegrees, PlaceConfidence Confidence);
