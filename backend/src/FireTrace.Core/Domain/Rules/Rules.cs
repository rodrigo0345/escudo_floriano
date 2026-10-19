namespace FireTrace.Core.Domain.Rules;

public sealed record Rules(string Version, string Notes, MovementRules Movement, WaterRules Water, CrewRules Crews, AerialRules Aerial, SafetyRules Safety, SuppressionRules Suppression);
