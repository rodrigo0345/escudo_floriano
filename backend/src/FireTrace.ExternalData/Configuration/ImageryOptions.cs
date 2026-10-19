namespace FireTrace.ExternalData.Configuration;

public sealed record ImageryOptions(string EoxUrl, string EoxAttribution, int ConcurrentTiles, int JpegQuality);
