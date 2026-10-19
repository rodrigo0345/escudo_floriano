namespace FireTrace.Core.Configuration;

public sealed record DefaultsSettings(int PageSize, int SpinUpHours, bool Spotting, EnsembleDefaults Ensemble, int EnsemblePreviewMembers, int WeatherStepMinutes, int SummaryStepMinutes,
    int VectorWindowMinutes, double MinProbability, string PlaceAccessOrigin, int PlaceAccessStepMinutes, int ThreatenedHorizonMinutes, double NearbyWaterRadiusM, int NearbyWaterLimit,
    int BuildingsLimit, int MinBuildings, int SeriesStepMinutes);
