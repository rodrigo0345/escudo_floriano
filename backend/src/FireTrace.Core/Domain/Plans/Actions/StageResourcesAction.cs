using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record StageResourcesAction : PlanAction { public required Target StagingArea { get; init; } public TimeSpec? HoldUntil { get; init; } public string? Readiness { get; init; } }
