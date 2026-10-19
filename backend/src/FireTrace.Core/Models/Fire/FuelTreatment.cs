using FireTrace.Core.Domain.Interventions;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

/// <summary>Células onde se cortou o combustível (árvores, sub-bosque ou tudo): o motor recebe a paisagem com o combustível já mudado.</summary>
public sealed record FuelTreatment(IReadOnlyCollection<int> Cells, FuelRemoval Removal);
