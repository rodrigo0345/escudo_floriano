using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Scenarios;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Simulations;

public sealed record Simulation : Entity
{
    public string? Label { get; init; }
    public SimulationKind Kind { get; init; } = SimulationKind.Baseline;
    public SimulationStatus Status { get; init; } = SimulationStatus.Queued;
    public string? ScenarioId { get; init; }
    public required Scenario ScenarioSnapshot { get; init; }
    public string? PlanId { get; init; }
    public string? ParentSimulationId { get; init; }
    public required string LocationId { get; init; }
    public SimulationProgress? Progress { get; init; }
    public SimulationStats? Stats { get; init; }
    public List<CrewExposure>? CrewExposures { get; init; }
    public ProblemInfo? Error { get; init; }
    public DateTimeOffset? StartedAt { get; init; }
    public DateTimeOffset? FinishedAt { get; init; }
    public Dictionary<string, string>? Links { get; init; }
}
