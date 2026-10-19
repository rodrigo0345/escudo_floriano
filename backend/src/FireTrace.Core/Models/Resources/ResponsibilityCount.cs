using FireTrace.Core.Domain.Dispatches;

namespace FireTrace.Core.Models.Resources;

public sealed record ResponsibilityCount(Responsibility Responsibility, int Vehicles, int Personnel);
