using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record ShelterInPlaceAction : PlanAction { public required Polygon Area { get; init; } public List<string>? PlaceIds { get; init; } public string? Guidance { get; init; } public int? DurationMinutes { get; init; } }
