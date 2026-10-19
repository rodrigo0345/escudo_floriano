using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Interventions;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.RoadClosures;

public sealed record RoadClosure : Entity
{
    public required string LocationId { get; init; }
    public List<string>? RoadIds { get; init; }
    public Geometry? Geometry { get; init; }
    public required ClosureKind Kind { get; init; }
    public required ClosureReason Reason { get; init; }
    public ClosureStatus Status { get; init; } = ClosureStatus.Proposed;
    public required DateTimeOffset Start { get; init; }
    public DateTimeOffset? End { get; init; }
    public Detour? Detour { get; init; }
    public List<Checkpoint>? Checkpoints { get; init; }
    public List<ClosureExemption>? Exemptions { get; init; }
    public string? ResponsibleOrganizationId { get; init; }
    public string Source { get; init; } = "manual";
    public string? SimulationId { get; init; }
    public PlanActionRef? PlanActionRef { get; init; }
    public double? Probability { get; init; }
    public string? Notes { get; init; }
}
