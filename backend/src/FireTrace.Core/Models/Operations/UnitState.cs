using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Operations;

/// <summary>O estado de um meio num minuto: onde está, o que faz, quanto falta para chegar, a água e o cansaço.</summary>
public sealed record UnitState(string UnitId, DispatchStatus Status, ResourceType? ResourceType = null, string? Callsign = null, string? OrganizationId = null, string? DispatchId = null,
    Responsibility? Responsibility = null, LatLon? Position = null, Target? Target = null, double? EtaMinutes = null, int? Personnel = null, WaterStatus? Water = null, CrewStatus? Crew = null,
    AerialStatus? Aerial = null);
