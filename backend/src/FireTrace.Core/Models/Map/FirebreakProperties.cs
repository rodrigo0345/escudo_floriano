using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record FirebreakProperties(string Id, string Kind, string? Name, double? WidthM, bool Maintained, string Source);
