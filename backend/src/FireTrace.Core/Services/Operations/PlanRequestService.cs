using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// Pedidos de planos aos agentes: o operador pede (`queued`), um agente reclama (`planning`), relata o progresso (`simulating`) e fecha (`done` com os planos,
/// ou `failed` com a razão). Um agente que deixa de dar notícias perde o pedido ao fim de `PlanRequestStaleMinutes`: outro (ou o mesmo, reiniciado) volta a reclamá-lo.
/// </summary>
public sealed class PlanRequestService(CrudService<PlanRequest> requests, SimulationService simulations, LimitsSettings limits, TimeProvider clock)
{
    readonly SemaphoreSlim _gate = new(1, 1); // reclamar e criar são ler-e-escrever: um de cada vez, para dois agentes não ficarem com o mesmo pedido

    /// <summary>Novo pedido para uma simulação base terminada; `Created = false` quando já havia um em curso (devolve-se esse).</summary>
    public async Task<(PlanRequest Request, bool Created)> CreateAsync(string simulationId, PlanRequestInput input, CancellationToken ct = default)
    {
        var simulation = await simulations.GetAsync(simulationId, ct);
        if (simulation.Kind != SimulationKind.Baseline)
            throw new ValidationException("Os agentes planeiam sobre uma simulação base; esta é um what-if (peça para a base dele).", "/simulationId");
        if (simulation.Status != SimulationStatus.Succeeded)
            throw new ConflictException($"A simulação está '{EnumText.ToSnake(simulation.Status)}'; os agentes só planeiam quando terminar com sucesso.", "simulation_not_ready");
        if (input.Note is { Length: var n } && n > limits.MaxPlanRequestNoteLength)
            throw new ValidationException($"`note` tem {n} caracteres; o máximo é {limits.MaxPlanRequestNoteLength}.", "/note");
        if (input.AtMinute is < 0) throw new ValidationException("`atMinute` não pode ser negativo.", "/atMinute");
        if (input.AtMinute is { } at && at >= simulation.ScenarioSnapshot.DurationMinutes)
            throw new ValidationException($"`atMinute` ({at}) tem de ser antes do fim da simulação ({simulation.ScenarioSnapshot.DurationMinutes} min).", "/atMinute");

        await _gate.WaitAsync(ct);
        try
        {
            var open = (await requests.ListAsync(r => r.SimulationId == simulationId && r.IsOpen, ct)).OrderByDescending(r => r.CreatedAt).FirstOrDefault();
            if (open is not null) return (open, false);
            var created = await requests.CreateAsync(new PlanRequest
            {
                SimulationId = simulationId, LocationId = simulation.LocationId, Note = Blank(input.Note), AtMinute = input.AtMinute, RequestedBy = Blank(input.RequestedBy),
                Progress = new PlanRequestProgress("queued", 0, "À espera de um agente"),
            }, ct);
            return (created, true);
        }
        finally { _gate.Release(); }
    }

    public Task<PlanRequest> GetAsync(string id, CancellationToken ct = default) => requests.GetAsync(id, ct);

    /// <summary>Mais recentes primeiro.</summary>
    public async Task<Page<PlanRequest>> PageAsync(PageQuery page, Func<PlanRequest, bool> filter, CancellationToken ct = default) =>
        page.Apply((await requests.ListAsync(filter, ct)).OrderByDescending(r => r.CreatedAt), r => r.UpdatedAt);

    public async Task<PlanRequest> ClaimAsync(string id, PlanRequestClaim claim, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(claim.Agent)) throw new ValidationException("Falta `agent`.", "/agent");
        await _gate.WaitAsync(ct);
        try
        {
            var request = await requests.GetAsync(id, ct);
            var now = clock.GetUtcNow();
            bool stale = request.Status is PlanRequestStatus.Planning or PlanRequestStatus.Simulating && now - request.UpdatedAt > TimeSpan.FromMinutes(limits.PlanRequestStaleMinutes);
            if (request.Status != PlanRequestStatus.Queued && !stale)
                throw new ConflictException(request.IsOpen
                    ? $"O pedido já está com '{request.ClaimedBy}' ('{EnumText.ToSnake(request.Status)}')."
                    : $"O pedido já terminou ('{EnumText.ToSnake(request.Status)}').", "plan_request_claimed");
            return await requests.SaveAsync(request with
            {
                Status = PlanRequestStatus.Planning, ClaimedBy = claim.Agent.Trim(), ClaimedAt = now, Error = null,
                Progress = new PlanRequestProgress("claimed", 2, stale ? $"Retomado por {claim.Agent.Trim()} (o agente anterior deixou de responder)" : $"{claim.Agent.Trim()} começou a planear"),
            }, ct);
        }
        finally { _gate.Release(); }
    }

    /// <summary>Progresso e fim, relatados pelo agente que tem o pedido. Cada relato renova o pedido (não fica "abandonado").</summary>
    public async Task<PlanRequest> PatchAsync(string id, PlanRequestPatch patch, CancellationToken ct = default)
    {
        var request = await requests.GetAsync(id, ct);
        if (!request.IsOpen) throw new ConflictException($"O pedido já terminou ('{EnumText.ToSnake(request.Status)}').", "invalid_transition");
        if (request.Status == PlanRequestStatus.Queued) throw new ConflictException("O pedido ainda não foi reclamado (POST /plan-requests/{id}/claim).", "invalid_transition");
        if (patch.Status == PlanRequestStatus.Queued) throw new ValidationException("Um pedido não volta a `queued`.", "/status");
        if (patch.Progress is { } p && (p.Percent is < 0 or > 100 || string.IsNullOrWhiteSpace(p.Phase)))
            throw new ValidationException("`progress` precisa de `phase` e de `percent` entre 0 e 100.", "/progress");

        var status = patch.Status ?? request.Status;
        var planIds = patch.PlanIds ?? request.PlanIds;
        if (status == PlanRequestStatus.Done && (planIds is null || planIds.Count == 0))
            throw new ValidationException("Um pedido `done` diz que planos publicou (`planIds`).", "/planIds");
        bool closing = status is PlanRequestStatus.Done or PlanRequestStatus.Failed;
        return await requests.SaveAsync(request with
        {
            Status = status, PlanIds = planIds, Progress = patch.Progress ?? request.Progress,
            Error = patch.Error ?? (status == PlanRequestStatus.Failed ? request.Error ?? "O agente não disse porquê." : request.Error),
            CompletedAt = closing ? clock.GetUtcNow() : null,
        }, ct);
    }

    static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
