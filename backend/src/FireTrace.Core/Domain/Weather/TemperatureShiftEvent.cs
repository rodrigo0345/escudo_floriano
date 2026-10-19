using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record TemperatureShiftEvent : WeatherEvent { public required TimeWindow Window { get; init; } public double? DeltaC { get; init; } public double? SetC { get; init; } public int RampMinutes { get; init; } }
