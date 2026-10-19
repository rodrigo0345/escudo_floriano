namespace FireTrace.Core.Domain.Rules;

public sealed record WaterRules(string ConsumptionLpm, double DutyCycle, RefillRules Refill);
