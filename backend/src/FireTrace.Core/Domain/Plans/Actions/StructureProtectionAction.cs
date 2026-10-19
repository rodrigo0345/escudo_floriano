using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record StructureProtectionAction : PlanAction { public required List<Target> Targets { get; init; } public string? Tactic { get; init; } }
