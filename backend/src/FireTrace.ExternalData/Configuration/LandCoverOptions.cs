namespace FireTrace.ExternalData.Configuration;

public sealed record LandCoverOptions(string WorldCoverUrl, int WorldCoverTileDegrees, Dictionary<string, string> WorldCoverClasses, string WorldCoverDefaultClass, string HrlUrl, string EarthSearchUrl,
    string EarthSearchCollection, int EarthSearchLimit, int MaxCloudCoverPct, SeasonRange WinterRange, SeasonRange SummerRange, double EvergreenMinWinterNdvi, double EvergreenMaxSummerDelta,
    int SpeciesRasterPixels, string UniformClass);
