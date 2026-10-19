using System.Text.Json;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

/// <summary>Estado em tempo real de uma viatura: muda com frequência, por isso é atualizado à parte da definição.</summary>
public sealed record VehicleState
{
    public VehicleStatus Status { get; init; } = VehicleStatus.Available;
    public LatLon? Position { get; init; }
    public double? HeadingDeg { get; init; }
    public double? SpeedKmh { get; init; }
    public int? CrewOnboard { get; init; }
    public WaterStatus? Water { get; init; }
    public double? FuelPct { get; init; }
    public CrewStatus? Crew { get; init; }
    public string? CurrentPlanId { get; init; }
    public string? CurrentActionId { get; init; }
    public string? CurrentDispatchId { get; init; }
    public Responsibility? Responsibility { get; init; }
    public Target? Target { get; init; }
    public DateTimeOffset? AvailableFrom { get; init; }
    public StateSource Source { get; init; } = StateSource.Manual;
    public DateTimeOffset UpdatedAt { get; init; }
}
