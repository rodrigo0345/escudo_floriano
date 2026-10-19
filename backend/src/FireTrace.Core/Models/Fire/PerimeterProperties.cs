using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record PerimeterProperties(int TMin, DateTimeOffset Time, double AreaHa, string? Percentile);
