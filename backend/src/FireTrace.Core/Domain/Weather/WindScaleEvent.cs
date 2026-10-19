using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record WindScaleEvent : WeatherEvent { public required TimeWindow Window { get; init; } public required double Factor { get; init; } public int RampMinutes { get; init; } public bool ApplyToGusts { get; init; } = true; }
