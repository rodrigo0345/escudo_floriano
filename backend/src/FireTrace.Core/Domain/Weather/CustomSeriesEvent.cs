using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record CustomSeriesEvent : WeatherEvent { public required List<WeatherSample> Samples { get; init; } }
