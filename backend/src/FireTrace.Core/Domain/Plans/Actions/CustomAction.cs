using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record CustomAction : PlanAction { public Dictionary<string, JsonElement>? Payload { get; init; } }
