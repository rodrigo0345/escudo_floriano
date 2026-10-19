using System.Text.Json.Serialization;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record FacilityView(string Id, string Name, string Kind, LatLon Position, string? Operator, int? Capacity, bool Vulnerable, string Source, string Confidence, string? StationId = null);
