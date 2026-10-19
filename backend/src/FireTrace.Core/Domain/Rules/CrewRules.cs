namespace FireTrace.Core.Domain.Rules;

public sealed record CrewRules(double ShiftLengthHours, int MaxContinuousWorkMinutes, int MandatoryRestMinutes, double FatiguePctPerHour, double MinimumEffectivenessPct);
