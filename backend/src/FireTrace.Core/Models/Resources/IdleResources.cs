using FireTrace.Core.Models.Map;

namespace FireTrace.Core.Models.Resources;

public sealed record IdleResources(IReadOnlyList<VehicleBrief> Vehicles, int Personnel, IReadOnlyList<CountBreakdown> Pools);
