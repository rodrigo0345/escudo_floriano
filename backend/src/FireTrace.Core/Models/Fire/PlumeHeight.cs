using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record PlumeHeight(double P50, double Max);
