namespace FireTrace.Core.Domain.Resources;

/// <summary>Combustível de uma viatura terrestre na simulação: quanto resta e, se está a ir abastecer, onde.</summary>
public sealed record FuelStatus(double? LevelPct = null, double? CapacityL = null, string? RefuelFacilityId = null);
