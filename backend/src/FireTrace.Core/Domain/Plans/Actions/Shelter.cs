using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record Shelter(LatLon Position, string? Name = null, string? FacilityId = null, int? Capacity = null);
