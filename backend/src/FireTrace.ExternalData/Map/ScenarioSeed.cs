namespace FireTrace.ExternalData.Map;

/// <summary>Cenário de exemplo que vem no ficheiro do local (ignição + data de início); a API transforma-o num cenário `builtin`.</summary>
public sealed record ScenarioSeed(string Id, string Name, double Lat, double Lon, DateTimeOffset Start, int DurationMinutes, string? Notes, bool Historical);
