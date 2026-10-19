using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record FireAttackAction : PlanAction
{
    public required string Tactic { get; init; }
    public LatLon? AnchorPoint { get; init; }
    public LineString? Line { get; init; }
    public string? Objective { get; init; }
    public List<LineString>? EscapeRoutes { get; init; }
    public List<LatLon>? SafetyZones { get; init; }
    public List<LatLon>? Lookouts { get; init; }
    public double? ExpectedEffectiveness { get; init; }
}
