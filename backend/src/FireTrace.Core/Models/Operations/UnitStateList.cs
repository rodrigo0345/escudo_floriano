namespace FireTrace.Core.Models.Operations;

/// <summary>Os meios de uma simulação ao minuto pedido.</summary>
public sealed record UnitStateList(string SimulationId, int TMin, IReadOnlyList<UnitState> Items);
