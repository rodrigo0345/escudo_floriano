namespace FireTrace.Core.Models.Operations;

/// <summary>`GET /simulations/{id}/units`: o estado de todos os meios do plano (ou despachos) que a simulação aplicou, ao minuto `tMin`.</summary>
public sealed record UnitStateList(string SimulationId, int TMin, IReadOnlyList<UnitState> Items);
