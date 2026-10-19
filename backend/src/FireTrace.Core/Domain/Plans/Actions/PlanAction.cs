using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Plans.Triggers;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

/// <summary>Uma coisa concreta a fazer, por uma organização, com meios, gatilho e justificação. O campo `type` escolhe o tipo.</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(DispatchUnitsAction), "dispatch_units")]
[JsonDerivedType(typeof(StageResourcesAction), "stage_resources")]
[JsonDerivedType(typeof(EstablishCommandPostAction), "establish_command_post")]
[JsonDerivedType(typeof(RoadClosureAction), "road_closure")]
[JsonDerivedType(typeof(TrafficControlPointAction), "traffic_control_point")]
[JsonDerivedType(typeof(EvacuationAction), "evacuation")]
[JsonDerivedType(typeof(ShelterInPlaceAction), "shelter_in_place")]
[JsonDerivedType(typeof(StructureProtectionAction), "structure_protection")]
[JsonDerivedType(typeof(FireAttackAction), "fire_attack")]
[JsonDerivedType(typeof(FuelBreakAction), "fuel_break")]
[JsonDerivedType(typeof(MedicalStandbyAction), "medical_standby")]
[JsonDerivedType(typeof(AirSupportRequestAction), "air_support_request")]
[JsonDerivedType(typeof(PublicAlertAction), "public_alert")]
[JsonDerivedType(typeof(RequestReinforcementsAction), "request_reinforcements")]
[JsonDerivedType(typeof(ReconnaissanceAction), "reconnaissance")]
[JsonDerivedType(typeof(CustomAction), "custom")]
public abstract record PlanAction
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string OrganizationId { get; init; }
    public string? Description { get; init; }
    public List<string>? SupportingOrganizationIds { get; init; }
    public ActionPriority Priority { get; init; } = ActionPriority.Normal;
    public ActionStatus Status { get; init; } = ActionStatus.Planned;
    public Trigger? Trigger { get; init; }
    public List<string>? DependsOn { get; init; }
    public int? ExpectedDurationMinutes { get; init; }
    public List<ResourceAssignment>? Resources { get; init; }
    public string? Rationale { get; init; }
    public string? ExpectedEffect { get; init; }
    public double? Confidence { get; init; }
    public string? SafetyNotes { get; init; }
    public List<Intervention>? SimulationEffects { get; init; }
    public ActionProgress? Progress { get; init; }
}
