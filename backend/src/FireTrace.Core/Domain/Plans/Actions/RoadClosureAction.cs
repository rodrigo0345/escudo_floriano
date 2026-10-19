using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.RoadClosures;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record RoadClosureAction : PlanAction
{
    public required List<string> RoadIds { get; init; }
    public Geometry? Geometry { get; init; }
    public required ClosureKind Kind { get; init; }
    public required ClosureReason Reason { get; init; }
    public TimeSpec? Until { get; init; }
    public Detour? Detour { get; init; }
    public List<Checkpoint>? Checkpoints { get; init; }
    public List<ClosureExemption>? Exemptions { get; init; }
    public string? ClosureId { get; init; }
}
