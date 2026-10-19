using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record WindSetEvent : WeatherEvent { public required TimeWindow Window { get; init; } public double? WindKmh { get; init; } public double? WindFromDeg { get; init; } public int RampMinutes { get; init; } }
