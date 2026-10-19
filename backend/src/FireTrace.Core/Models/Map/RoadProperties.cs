using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record RoadProperties(string Id, string Name, string? Ref, [property: JsonPropertyName("class")] string Class, double LengthM, bool RequiresOffRoad,
    string? Tracktype = null, double? WidthM = null, string? Status = null, string? ClosureId = null);
