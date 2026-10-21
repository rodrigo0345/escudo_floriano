using FireTrace.Core.Domain.Plans;

namespace FireTrace.Core.Models.Operations;

public sealed record PlanRequestPatch(PlanRequestStatus? Status = null, PlanRequestProgress? Progress = null, List<string>? PlanIds = null, string? Error = null);
