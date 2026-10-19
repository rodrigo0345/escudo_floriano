namespace FireTrace.Core.Domain.Rules;

public sealed record MovementRules(IReadOnlyList<RoadSpeedFactor> RoadSpeedFactor, double OffRoadSpeedKmh, SlopePenalty SlopePenalty, double EmergencyVehicleFactor, double FireClearanceM);
