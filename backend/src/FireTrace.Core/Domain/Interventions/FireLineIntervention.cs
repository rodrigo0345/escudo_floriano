using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

public sealed record FireLineIntervention : Intervention { public required LineString Geometry { get; init; } public int? ConstructionMinutes { get; init; } public required double Effectiveness { get; init; } public string? Method { get; init; } }
