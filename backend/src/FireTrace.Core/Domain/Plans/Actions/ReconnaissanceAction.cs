using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record ReconnaissanceAction : PlanAction { public required string Method { get; init; } public required Target Area { get; init; } public int? UpdateIntervalMinutes { get; init; } }
