using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

public sealed record AerialDropIntervention : Intervention { public required Geometry Geometry { get; init; } public string? Agent { get; init; } public required double Effectiveness { get; init; } public int? EffectDurationMinutes { get; init; } }
