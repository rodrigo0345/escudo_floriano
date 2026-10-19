namespace FireTrace.Core.Models.Meta;

public sealed record Limits(int MaxDurationMinutes, int MaxIgnitions, int MaxEnsembleMembers, int MaxKeyframes, int MaxActionsPerPlan);
