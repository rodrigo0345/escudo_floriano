using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

/// <summary>Ponto-chave esparso: só as variáveis indicadas são fixadas; as restantes continuam com a série base ou com o ponto anterior.</summary>
public sealed record WeatherKeyframe : WeatherCore
{
    public required TimeSpec At { get; init; }
    public double? GustKmh { get; init; }
    public double? PressureHpa { get; init; }
    public double? PrecipitationMmH { get; init; }
    public double? CloudCoverPct { get; init; }
    public int? HainesIndex { get; init; }
    public string? Transition { get; init; }
    public string? Label { get; init; }
}
