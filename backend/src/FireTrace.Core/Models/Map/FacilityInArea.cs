using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record FacilityInArea(string FacilityId, string Name, string Kind, bool Vulnerable, int? Capacity);
