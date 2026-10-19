using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

/// <summary>O efeito de um conjunto de decisões sobre o motor: a propagação por célula, o combustível cortado e os edifícios que continuam a contar como afetados.</summary>
public sealed record InterventionEffect(float[] Adjustment, float[]? BuildingFactor, IReadOnlyList<FuelTreatment> Treatments);
