using System.Collections.Concurrent;
using FireTrace.Core.Domain.Common;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record ArrivalEntry(string? Id, LatLon Position, bool Reached, double Probability, Quantiles? ArrivalMinute, DateTimeOffset? ArrivalTime, double? IntensityKwm, bool CrownFire);
