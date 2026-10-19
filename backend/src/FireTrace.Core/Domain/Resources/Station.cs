using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record Station : Entity
{
    public required string OrganizationId { get; init; }
    public required string Name { get; init; }
    public required StationKind Kind { get; init; }
    public required string LocationId { get; init; }
    public required LatLon Position { get; init; }
    public string? Address { get; init; }
    public string? FacilityId { get; init; }
    public int? VehicleBays { get; init; }
    public StationStatus Status { get; init; } = StationStatus.Operational;
    public List<Contact>? Contacts { get; init; }
}
