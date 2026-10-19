using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Dispatches;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

public sealed record CrewDeploymentIntervention : Intervention
{
    public required Responsibility Responsibility { get; init; }
    public required int Personnel { get; init; }
    public int? Vehicles { get; init; }
    public double? WaterL { get; init; }
    public required Geometry Geometry { get; init; }
    public double? Effectiveness { get; init; }
    public int? DurationMinutes { get; init; }
}
