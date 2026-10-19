namespace FireTrace.ExternalData.Map;

public sealed record CuratedFacility(string Type, string Name, double Lat, double Lon, string? Operator, string Source);
