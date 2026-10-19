using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record ArrivalRequest(List<ArrivalPoint> Points);
