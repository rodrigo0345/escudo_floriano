using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.RoadClosures;

public sealed record Checkpoint(LatLon Position, string? Label = null, string? OrganizationId = null, int? Personnel = null, int? Vehicles = null, List<EquipmentNeed>? Equipment = null);
