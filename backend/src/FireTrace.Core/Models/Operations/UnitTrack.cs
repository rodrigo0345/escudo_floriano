namespace FireTrace.Core.Models.Operations;

/// <summary>Trajeto e acontecimentos de um meio ao longo da simulação.</summary>
public sealed record UnitTrack(string SimulationId, string UnitId, int StepMin, IReadOnlyList<UnitTrackPoint> Points, IReadOnlyList<UnitEvent> Events);
