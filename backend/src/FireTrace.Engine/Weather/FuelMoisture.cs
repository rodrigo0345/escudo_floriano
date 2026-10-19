namespace FireTrace.Engine.Weather;

public sealed record FuelMoisture(double? Dead1hPct = null, double? Dead10hPct = null, double? Dead100hPct = null, double? LiveHerbaceousPct = null,
    double? LiveWoodyPct = null, double? FoliarPct = null);
