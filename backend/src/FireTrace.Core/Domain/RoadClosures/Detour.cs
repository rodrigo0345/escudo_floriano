using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.RoadClosures;

public sealed record Detour(LineString? Geometry = null, string? Description = null, double? ExtraMinutes = null);
