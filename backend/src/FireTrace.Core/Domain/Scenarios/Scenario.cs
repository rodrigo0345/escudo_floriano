using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Weather;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Scenarios;

/// <summary>Definição reutilizável de uma situação a simular: onde, quando, que meteorologia, que meios, que decisões.</summary>
public sealed record Scenario : Entity
{
    public required string Name { get; init; }
    public string? Description { get; init; }
    public required string LocationId { get; init; }
    public ScenarioPurpose? Purpose { get; init; }
    public required DateTimeOffset Start { get; init; }
    public required int DurationMinutes { get; init; }
    public required List<Ignition> Ignitions { get; init; }
    public InitialFire? InitialFire { get; init; }
    public WeatherSpec? Weather { get; init; }
    public ScenarioResources? Resources { get; init; }
    public List<Intervention>? Interventions { get; init; }
    public EngineOptions? Engine { get; init; }
    /// <summary>Cenários de exemplo que vêm com o local: não se apagam.</summary>
    public bool Builtin { get; init; }
}
