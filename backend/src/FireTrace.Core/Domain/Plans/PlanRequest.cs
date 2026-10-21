using System.Text.Json.Serialization;
using FireTrace.Core.Domain.Common;

namespace FireTrace.Core.Domain.Plans;

/// <summary>
/// O operador pede aos agentes um novo par de planos para uma simulação base. O serviço dos agentes reclama o pedido, relata o progresso
/// e no fim diz que planos publicou: é o único canal entre a interface e os agentes, que não precisam de saber de antemão que simulação tratar.
/// </summary>
public sealed record PlanRequest : Entity
{
    public required string SimulationId { get; init; }
    public required string LocationId { get; init; }
    public PlanRequestStatus Status { get; init; } = PlanRequestStatus.Queued;
    public string? Note { get; init; }
    public int? AtMinute { get; init; }
    public string? RequestedBy { get; init; }
    public string? ClaimedBy { get; init; }
    public DateTimeOffset? ClaimedAt { get; init; }
    public PlanRequestProgress? Progress { get; init; }
    public List<string>? PlanIds { get; init; }
    public string? Error { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }

    [JsonIgnore] public bool IsOpen => Status is PlanRequestStatus.Queued or PlanRequestStatus.Planning or PlanRequestStatus.Simulating;
}
