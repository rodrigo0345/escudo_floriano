namespace FireTrace.Core.Models.Resources;

public sealed record UnavailableResources(IReadOnlyList<VehicleBrief> Vehicles, int Personnel);
