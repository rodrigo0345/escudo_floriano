using System.Collections.Concurrent;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record RoadImpact(string RoadId, string Name, string? Ref, string Class, string Status, double CutProbability, Quantiles FirstCutMinute, double LengthM);
