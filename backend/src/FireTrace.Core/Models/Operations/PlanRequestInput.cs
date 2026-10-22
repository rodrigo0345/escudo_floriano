namespace FireTrace.Core.Models.Operations;

public sealed record PlanRequestInput(string? Note = null, int? AtMinute = null, string? RequestedBy = null);
