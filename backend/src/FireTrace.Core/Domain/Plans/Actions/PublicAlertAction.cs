using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record PublicAlertAction : PlanAction { public required List<string> Channels { get; init; } public Polygon? Area { get; init; } public required List<LocalizedMessage> Messages { get; init; } public AlertLevel? Severity { get; init; } }
