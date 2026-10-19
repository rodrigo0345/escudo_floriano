using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record TrafficControlPointAction : PlanAction { public required LatLon Position { get; init; } public string? RoadId { get; init; } public required string Mode { get; init; } public string? Instructions { get; init; } }
