using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record RoadStatusTimeline(string SimulationId, int HorizonMinutes, IReadOnlyList<RoadStatusEntry> Roads);
