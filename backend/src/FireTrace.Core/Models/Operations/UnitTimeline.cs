using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;

namespace FireTrace.Core.Models.Operations;

/// <summary>Tudo o que um meio faz num plano, minuto a minuto: o que `OperationSimulator` calcula e de onde se tiram os estados e os trajetos.</summary>
public sealed record UnitTimeline(string UnitId, ResourceType ResourceType, string Callsign, string OrganizationId, string ActionId, Responsibility? Responsibility, Target Target, int Personnel,
    double? WaterCapacityL, double? ConsumptionLpm, int ArrivesAtMinute, IReadOnlyList<UnitTrackPoint> Points, IReadOnlyList<UnitEvent> Events);
