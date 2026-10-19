namespace FireTrace.ExternalData.Configuration;

public sealed record OverpassOptions(string[] Endpoints, int MaxAttempts, int RetryDelaySeconds, int QueryTimeoutSeconds, int PlacesQueryTimeoutSeconds, double BboxPadDegrees, OverpassBlocks Blocks);
