namespace FireTrace.Core.Domain.Rules;

public sealed record RefillRules(double SetupMinutes, double DefaultFlowLpm, double HydrantFlowLpm, double RetreatBelowPct, IReadOnlyList<string> Sources);
