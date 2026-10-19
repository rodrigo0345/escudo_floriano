namespace FireTrace.Core.Configuration;

public sealed record DatabaseSettings(int MaxRetryBackoffSeconds, int RetryBackoffMultiplier);
