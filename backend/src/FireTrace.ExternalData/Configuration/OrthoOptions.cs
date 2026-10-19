namespace FireTrace.ExternalData.Configuration;

public sealed record OrthoOptions(string WmsUrl, string Layer, string Source, string Attribution, int RequestPixels, int ConcurrentRequests, int Retries, int JpegQuality);
