using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

/// <summary>O essencial da meteorologia num instante: vento (velocidade e de onde sopra), temperatura e humidade relativa.</summary>
public record WeatherCore
{
    public double? WindKmh { get; init; }
    public double? WindFromDeg { get; init; }
    public double? TempC { get; init; }
    public double? HumidityPct { get; init; }
}
