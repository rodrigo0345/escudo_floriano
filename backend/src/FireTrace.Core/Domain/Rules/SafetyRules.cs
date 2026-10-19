namespace FireTrace.Core.Domain.Rules;

public sealed record SafetyRules(double MinSafeDistanceM, bool RequireEscapeRoute, int WithdrawWhenFireArrivesInMinutes, double MinGroundVisibilityM);
