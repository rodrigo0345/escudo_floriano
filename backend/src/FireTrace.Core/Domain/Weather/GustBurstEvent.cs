using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record GustBurstEvent : WeatherEvent { public required TimeWindow Window { get; init; } public required double PeakGustKmh { get; init; } public double? PeriodMinutes { get; init; } }
