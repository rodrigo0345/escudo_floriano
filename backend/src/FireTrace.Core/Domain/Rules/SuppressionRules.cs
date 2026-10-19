namespace FireTrace.Core.Domain.Rules;

public sealed record SuppressionRules(double BaseEffectiveness, double PerCrewEquivalent, double MaxEffectiveness, double PersonsPerCrewEquivalent, double WaterBonusPerThousandL, double ZoneRadiusM, double FullEffectUpToKwm, double NoEffectFromKwm);
