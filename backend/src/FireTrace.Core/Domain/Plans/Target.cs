using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

/// <summary>Onde atua uma ação ou um despacho: indique pelo menos um dos campos.</summary>
public sealed record Target(string? Label = null, LatLon? Position = null, Geometry? Geometry = null, string? PlaceId = null, string? FacilityId = null,
    string? WaterPointId = null, string? RoadId = null)
{
    [JsonIgnore] public bool IsEmpty => Position is null && Geometry is null && PlaceId is null && FacilityId is null && WaterPointId is null && RoadId is null;
}
