using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

/// <summary>Efeito físico de uma decisão que o motor pode aplicar: liga um plano a uma simulação.</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(RoadClosureIntervention), "road_closure")]
[JsonDerivedType(typeof(FireLineIntervention), "fire_line")]
[JsonDerivedType(typeof(FuelRemovalIntervention), "fuel_removal")]
[JsonDerivedType(typeof(AerialDropIntervention), "aerial_drop")]
[JsonDerivedType(typeof(BackfireIntervention), "backfire")]
[JsonDerivedType(typeof(CrewDeploymentIntervention), "crew_deployment")]
[JsonDerivedType(typeof(StructureProtectionIntervention), "structure_protection")]
[JsonDerivedType(typeof(EvacuationIntervention), "evacuation")]
public abstract record Intervention
{
    public string? Id { get; init; }
    public string? Label { get; init; }
    public required TimeSpec Start { get; init; }
    public PlanActionRef? PlanActionRef { get; init; }
}
