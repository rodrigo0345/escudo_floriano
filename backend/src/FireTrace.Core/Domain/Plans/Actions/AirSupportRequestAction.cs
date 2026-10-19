using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record AirSupportRequestAction : PlanAction { public required string SupportKind { get; init; } public required Target TargetArea { get; init; } public List<string>? WaterPointIds { get; init; } public string? RequestedFrom { get; init; } public TimeSpec? NeedBy { get; init; } }
