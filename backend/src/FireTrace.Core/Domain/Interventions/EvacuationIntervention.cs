using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

public sealed record EvacuationIntervention : Intervention { public Polygon? Geometry { get; init; } public List<string>? PlaceIds { get; init; } public TimeSpec? CompleteBy { get; init; } public int? Population { get; init; } }
