using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record EvacuationAction : PlanAction
{
    public required Polygon Area { get; init; }
    public List<string>? PlaceIds { get; init; }
    public int? EstimatedPeople { get; init; }
    public List<string>? PriorityGroups { get; init; }
    public required string Mode { get; init; }
    public List<EvacuationRoute>? Routes { get; init; }
    public List<Shelter>? Shelters { get; init; }
    public TimeSpec? StartBy { get; init; }
    public TimeSpec? CompleteBy { get; init; }
}
