using System.Collections.Concurrent;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record RoadStatusEntry(string RoadId, string Class, string Name, Quantiles CutAtMinute, Quantiles ReopenAtMinute, double CutProbability, string? ActiveClosureId);
