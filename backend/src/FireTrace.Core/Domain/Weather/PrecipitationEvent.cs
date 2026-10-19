using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record PrecipitationEvent : WeatherEvent { public required TimeWindow Window { get; init; } public required double IntensityMmH { get; init; } public int RampMinutes { get; init; } }
