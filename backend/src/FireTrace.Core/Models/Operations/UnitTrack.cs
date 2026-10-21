namespace FireTrace.Core.Models.Operations;

/// <summary>`GET /simulations/{id}/units/{unitId}/track`: a posição e o estado de um meio ao longo do tempo, e os seus acontecimentos.</summary>
public sealed record UnitTrack(string SimulationId, string UnitId, int StepMin, IReadOnlyList<UnitTrackPoint> Points, IReadOnlyList<UnitEvent> Events);
