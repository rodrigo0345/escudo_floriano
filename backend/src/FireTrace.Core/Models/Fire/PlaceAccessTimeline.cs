using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record PlaceAccessTimeline(string SimulationId, string Origin, int StepMin, IReadOnlyList<int> Times, IReadOnlyList<PlaceAccess> Places);
