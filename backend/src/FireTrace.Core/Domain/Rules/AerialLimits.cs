namespace FireTrace.Core.Domain.Rules;

public sealed record AerialLimits(double MaxWindKmh, double MinVisibilityM, bool DayOnly, double MaxDistanceToWaterKm);
