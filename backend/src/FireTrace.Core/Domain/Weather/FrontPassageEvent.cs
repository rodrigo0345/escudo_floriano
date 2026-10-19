using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record FrontPassageEvent : WeatherEvent
{
    public required TimeSpec At { get; init; }
    public required int DurationMinutes { get; init; }
    public double? WindKmh { get; init; }
    public double? WindFromDeg { get; init; }
    public double? TempDeltaC { get; init; }
    public double? HumidityDeltaPct { get; init; }
    public double? PressureDeltaHpa { get; init; }
    public double? PrecipitationMmH { get; init; }
}
