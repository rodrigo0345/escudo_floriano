using System.Collections.Concurrent;

namespace FireTrace.Core.Models.Fire;

public sealed record SmokeQueryResult(string SimulationId, double MinGroundVisibilityM, double MinAerialVisibilityM, IReadOnlyList<SmokeSeries> Items);
