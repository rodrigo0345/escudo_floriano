using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Plans.Actions;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

/// <summary>Plano de resposta: o agente propõe o A e o B, o operador escolhe e ajusta, e depois ativa-se.</summary>
public sealed record Plan : Entity
{
    public required string LocationId { get; init; }
    public required string Title { get; init; }
    public string? Variant { get; init; }
    public string? Strategy { get; init; }
    public string? Summary { get; init; }
    public PlanBasis? Basis { get; init; }
    public List<Objective>? Objectives { get; init; }
    public AlertLevel? AlertLevel { get; init; }
    public PlanHorizon? Horizon { get; init; }
    public required List<PlanAction> Actions { get; init; }
    public List<string>? Assumptions { get; init; }
    public List<PlanRisk>? Risks { get; init; }
    public double? Confidence { get; init; }
    public PlanStatus Status { get; init; } = PlanStatus.Proposed;
    public ActorRef? Author { get; init; }
    public List<PlanStatusChange>? StatusHistory { get; init; }
    public PlanValidation? Validation { get; init; }
    public DateTimeOffset? ActivatedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
}
