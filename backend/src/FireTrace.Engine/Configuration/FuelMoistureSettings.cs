namespace FireTrace.Engine.Configuration;

public sealed record FuelMoistureSettings(double LiveHerbaceousPct, double LiveWoodyPct, double Dead1hPct, double Dead10hPct, double Dead100hPct, double TimeLag1hMinutes, double TimeLag10hMinutes,
    double TimeLag100hMinutes, int EquilibriumSampleMinutes, double MinEquilibriumMoisture, double MaxEquilibriumMoisture, double MinDeadMoisturePct);
