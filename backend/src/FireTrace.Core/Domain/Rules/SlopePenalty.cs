namespace FireTrace.Core.Domain.Rules;

public sealed record SlopePenalty(double StartsAtPercent, double SlowdownPerPercent, double MaxSlopeDefaultPercent);
