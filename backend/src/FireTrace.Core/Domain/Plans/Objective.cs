using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

public sealed record Objective([property: JsonPropertyName("objective")] string Kind, double? Weight = null);
