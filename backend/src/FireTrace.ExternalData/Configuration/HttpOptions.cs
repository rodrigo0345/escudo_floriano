namespace FireTrace.ExternalData.Configuration;

public sealed record HttpOptions(string UserAgent, int TimeoutMinutes, int Retries, int RetryDelayMs, int RangeBlockBytes, int RangeRetries, int RangeRetryDelayMs);
