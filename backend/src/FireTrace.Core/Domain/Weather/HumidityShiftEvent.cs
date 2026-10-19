using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record HumidityShiftEvent : WeatherEvent { public required TimeWindow Window { get; init; } public double? DeltaPct { get; init; } public double? SetPct { get; init; } public int RampMinutes { get; init; } }
