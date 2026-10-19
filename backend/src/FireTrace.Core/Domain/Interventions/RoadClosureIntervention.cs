using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

public sealed record RoadClosureIntervention : Intervention { public List<string>? RoadIds { get; init; } public Geometry? Geometry { get; init; } public TimeSpec? End { get; init; } }
