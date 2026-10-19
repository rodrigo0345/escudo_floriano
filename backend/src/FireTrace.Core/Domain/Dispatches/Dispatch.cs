using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Dispatches;

/// <summary>Despacho de um meio: o estado atual de cada ativo, com quem vai, para onde e com que função.</summary>
public sealed record Dispatch : Entity
{
    public required string OrganizationId { get; init; }
    public required ResourceType ResourceType { get; init; }
    public required string ResourceId { get; init; }
    public required int Personnel { get; init; }
    public required Responsibility Responsibility { get; init; }
    public required Target Target { get; init; }
    public string? FromStationId { get; init; }
    public DateTimeOffset? StartAt { get; init; }
    public int? ExpectedDurationMinutes { get; init; }
    public LineString? Route { get; init; }
    public string? Notes { get; init; }
    public DispatchStatus Status { get; init; } = DispatchStatus.Ordered;
    public double? EtaMinutes { get; init; }
    public LatLon? Position { get; init; }
    public int? CrewOnboard { get; init; }
    public DateTimeOffset? ArrivedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
    public DispatchSource Source { get; init; } = DispatchSource.Api;
    public string? PlanId { get; init; }
    public string? ActionId { get; init; }
    public string? Reason { get; init; }
    public WaterStatus? Water { get; init; }
    public CrewStatus? Crew { get; init; }
    public AerialStatus? Aerial { get; init; }

    [JsonIgnore] public bool IsActive => Status is not (DispatchStatus.Completed or DispatchStatus.Cancelled or DispatchStatus.Failed);
}
