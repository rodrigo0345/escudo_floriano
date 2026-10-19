namespace FireTrace.Core.Domain.Rules;

public sealed record AerialRules(HelicopterRules Helicopter, AirtankerRules Airtanker, AerialLimits Limits, string CycleTime);
