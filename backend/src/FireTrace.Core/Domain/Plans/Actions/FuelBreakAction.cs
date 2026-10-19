using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Interventions;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

/// <summary>Abrir uma faixa de gestão de combustível (cortar árvores/mato) ao longo de uma linha, por exemplo para travar o fogo antes de ele chegar.</summary>
public sealed record FuelBreakAction : PlanAction
{
    public required LineString Line { get; init; }
    public double? WidthM { get; init; }
    public required FuelRemoval Removal { get; init; }
    public string? Method { get; init; }
    public string? Objective { get; init; }
    public List<LineString>? EscapeRoutes { get; init; }
    public List<LatLon>? SafetyZones { get; init; }
    public List<LatLon>? Lookouts { get; init; }
}
