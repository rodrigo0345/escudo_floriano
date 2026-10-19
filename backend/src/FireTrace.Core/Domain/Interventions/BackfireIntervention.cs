using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

public sealed record BackfireIntervention : Intervention { public required LineString Geometry { get; init; } public int? DurationMinutes { get; init; } }
