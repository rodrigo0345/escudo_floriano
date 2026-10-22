namespace FireTrace.Core.Domain.Rules;

/// <summary>Combustível das viaturas terrestres: quanto gastam a andar e a trabalhar, quando vão abastecer e onde.</summary>
public sealed record FuelRules(double DefaultCapacityL, double DrivingLPer100Km, double WorkingLph, double RefuelBelowPct, double RefuelMinutes, IReadOnlyList<string> Sources);
