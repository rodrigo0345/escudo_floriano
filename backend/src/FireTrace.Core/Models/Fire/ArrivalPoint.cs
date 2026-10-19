using System.Collections.Concurrent;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record ArrivalPoint(string? Id, LatLon Position);
