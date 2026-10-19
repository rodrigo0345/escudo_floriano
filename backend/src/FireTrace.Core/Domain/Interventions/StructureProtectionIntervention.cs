using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

public sealed record StructureProtectionIntervention : Intervention { public string? PlaceId { get; init; } public Polygon? Geometry { get; init; } public required double Effectiveness { get; init; } }
