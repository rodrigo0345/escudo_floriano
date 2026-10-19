using FireTrace.Core.Domain.Dispatches;

namespace FireTrace.Core.Models.Resources;

public sealed record DeploymentOverview(string LocationId, DateTimeOffset AsOf, IReadOnlyList<DeploymentGroup> ByResponsibility, IdleResources Idle, UnavailableResources Unavailable,
    IReadOnlyList<Dispatch> Dispatches);
