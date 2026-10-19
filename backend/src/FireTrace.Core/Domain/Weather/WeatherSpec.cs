using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Engine.Weather;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

/// <summary>Receita completa da meteorologia de uma simulação: série real, pontos-chave e eventos, por esta ordem.</summary>
public sealed record WeatherSpec
{
    public WeatherBase Base { get; init; } = WeatherBase.Provider;
    public ProviderOptions? Provider { get; init; }
    public List<WeatherKeyframe>? Keyframes { get; init; }
    public List<WeatherEvent>? Events { get; init; }
    public Interpolation? Interpolation { get; init; }
    public FuelMoistureSpec? FuelMoisture { get; init; }
    public EnsembleSpec? Ensemble { get; init; }
    public int? SpinUpHours { get; init; }
}
