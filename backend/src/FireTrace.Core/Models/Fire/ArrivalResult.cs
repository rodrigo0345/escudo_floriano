using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record ArrivalResult(string SimulationId, IReadOnlyList<ArrivalEntry> Items);
