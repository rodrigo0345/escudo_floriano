using FireTrace.Engine.Contracts;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

/// <summary>
/// O efeito de um conjunto de decisões sobre o motor: a propagação por célula (permanente), o combustível cortado, os edifícios que continuam a contar como afetados
/// e, quando o motor aceita tempo, as janelas em que equipas, largadas e linhas travam o fogo (ver <see cref="SuppressionPlan"/>).
/// </summary>
public sealed record InterventionEffect(float[] Adjustment, float[]? BuildingFactor, IReadOnlyList<FuelTreatment> Treatments, IReadOnlyList<SuppressionWindow>? Windows = null);
