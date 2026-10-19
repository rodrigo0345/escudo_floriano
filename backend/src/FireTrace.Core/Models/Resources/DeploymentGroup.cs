using FireTrace.Core.Domain.Dispatches;

namespace FireTrace.Core.Models.Resources;

public sealed record DeploymentGroup(Responsibility Responsibility, IReadOnlyList<VehicleBrief> Vehicles, int VehicleCount, int Personnel);
