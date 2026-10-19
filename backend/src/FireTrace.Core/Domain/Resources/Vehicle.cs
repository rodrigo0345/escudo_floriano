using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record Vehicle : Entity
{
    public required string OrganizationId { get; init; }
    public required string Callsign { get; init; }
    public required VehicleType Type { get; init; }
    public string? TypeCode { get; init; }
    public string? StationId { get; init; }
    public string? Plate { get; init; }
    public required int CrewCapacity { get; init; }
    public int? MinimumCrew { get; init; }
    public double? WaterCapacityL { get; init; }
    public double? FoamCapacityL { get; init; }
    public double? PumpFlowLpm { get; init; }
    public int? PassengerCapacity { get; init; }
    public int? StretcherCapacity { get; init; }
    public bool OffRoad { get; init; }
    public double? MaxSlopePercent { get; init; }
    public double? HeightM { get; init; }
    public double? WidthM { get; init; }
    public double? WeightT { get; init; }
    public double? CruiseSpeedKmh { get; init; }
    public double? RangeKm { get; init; }
    public double? FuelCapacityL { get; init; }
    public List<VehicleCapability>? Capabilities { get; init; }
    public AerialSpec? Aerial { get; init; }
    public bool InService { get; init; } = true;
    public VehicleState State { get; init; } = new();
}
