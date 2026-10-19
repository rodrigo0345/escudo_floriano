using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record DispatchUnitsAction : PlanAction { public required Target Target { get; init; } public required string Mission { get; init; } }
