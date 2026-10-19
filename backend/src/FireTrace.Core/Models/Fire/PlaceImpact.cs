using System.Collections.Concurrent;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record PlaceImpact(string PlaceId, string Name, int Population, string Status, double FireArrivalProbability, Quantiles FirstArrivalMinute, BestAccess BestAccess);
