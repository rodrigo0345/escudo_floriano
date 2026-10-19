using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record WindShiftEvent : WeatherEvent
{
    public required TimeSpec Start { get; init; }
    public double? ToDeg { get; init; }
    public double? DeltaDeg { get; init; }
    public string Rotation { get; init; } = "shortest_arc";
    public int RampMinutes { get; init; }
    public int? HoldMinutes { get; init; }
    public int? ReturnRampMinutes { get; init; }
}
