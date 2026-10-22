using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Engine.Weather;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

/// <summary>Meteorologia num instante. Todos os campos, exceto `time`, são opcionais: a fonte preenche o que souber.</summary>
public sealed record WeatherSample : WeatherCore
{
    public required DateTimeOffset Time { get; init; }
    public string? Source { get; init; }
    public double? GustKmh { get; init; }
    /// <summary>Humidade (%) do combustível morto fino que alimenta o motor: equilíbrio de Simard, atraso das classes e chuva. Quanto mais baixa, mais depressa arde.</summary>
    public double? FineFuelMoisturePct { get; init; }
    public double? DewPointC { get; init; }
    public double? PressureHpa { get; init; }
    public double? PrecipitationMmH { get; init; }
    public double? CloudCoverPct { get; init; }
    public double? SolarRadiationWm2 { get; init; }
    /// <summary>Visibilidade horizontal à superfície (m). A previsão Open-Meteo fornece-a; o arquivo ERA5 não.</summary>
    public double? VisibilityM { get; init; }
    /// <summary>Energia potencial convectiva disponível (J/kg): instabilidade para trovoadas.</summary>
    public double? CapeJkg { get; init; }
    /// <summary>Sol acima do horizonte (`is_day` da fonte, ou calculado da radiação solar). Os agentes continuam a usar `daylight.py` para o pôr do sol exato.</summary>
    public bool? IsDay { get; init; }
    public int? HainesIndex { get; init; }
    public double? KeetchByramIndex { get; init; }
    public FuelMoisture? FuelMoisture { get; init; }
}
