namespace FireTrace.ExternalData.Map;

public sealed record Place(long Id, string Name, string Kind, double Lat, double Lon, int Population, bool PopulationEstimated);
