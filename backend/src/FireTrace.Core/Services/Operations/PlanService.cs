using System.Text.Json;
using System.Text.RegularExpressions;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans.Triggers;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Fire;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// O ciclo de um plano: o agente propõe (A e B), o operador escolhe e ajusta, ativa-se (cria despachos e cortes de estrada), simula-se e fecha-se.
/// Também guarda a execução de cada ação por quem as cumpre.
/// </summary>
public sealed class PlanService(CrudService<Plan> plans, PlanValidator validator, DispatchService dispatching, CrudService<Dispatch> dispatches, CrudService<RoadClosure> closures,
    PlanRouter router, PlanInterventions interventions, SimulationService simulations, IDocumentStore<Simulation> simulationStore, TimeProvider clock, ILogger<PlanService> log)
{
    // ===================================================================================================== criar e alterar
    public Task<PlanValidation> ValidateAsync(Plan input, CancellationToken ct = default) => validator.ValidateAsync(input, ct);

    public async Task<Plan> CreateAsync(Plan input, CancellationToken ct = default)
    {
        var begin = System.Diagnostics.Stopwatch.GetTimestamp();
        (input, var routedKeys) = await router.ApplyWithKeysAsync(input, ct);
        var routingDuration = System.Diagnostics.Stopwatch.GetElapsedTime(begin);
        // validar uma só vez: a política do plano valida ao criar, o que repetia a mesma conta cara (rotas e fumo por ação) sobre o mesmo conteúdo
        var validation = await validator.ValidateAsync(input, ct, routedKeys);
        if (validation.Issues.Any(i => i.Severity == "error")) throw new ValidationException(validation.Issues);
        var plan = input with
        {
            Status = PlanStatus.Proposed, StatusHistory = new() { new(PlanStatus.Proposed, clock.GetUtcNow(), input.Author) }, Validation = validation,
            ActivatedAt = null, CompletedAt = null,
        };
        var validated = System.Diagnostics.Stopwatch.GetElapsedTime(begin) - routingDuration;
        var saved = await plans.CreateValidatedAsync(plan, ct);
        // onde se gasta o tempo de publicar um plano: sem isto "é lento" não se mede
        log.LogInformation("plano criado: {Actions} ações, rotas {RoutesMs:F0} ms, validação {ValidateMs:F0} ms, total {TotalMs:F0} ms",
            input.Actions.Count, routingDuration.TotalMilliseconds, validated.TotalMilliseconds, System.Diagnostics.Stopwatch.GetElapsedTime(begin).TotalMilliseconds);
        return saved;
    }

    public async Task<Plan> PatchAsync(string id, JsonElement patch, CancellationToken ct = default)
    {
        var plan = await plans.GetAsync(id, ct);
        if (plan.Status is not (PlanStatus.Proposed or PlanStatus.Selected or PlanStatus.Active)) throw new ConflictException($"O plano já está '{EnumText.ToSnake(plan.Status)}'.", "invalid_transition");

        PlanStatus? closing = patch.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.String
            ? s.GetString() switch { "completed" => PlanStatus.Completed, "cancelled" => PlanStatus.Cancelled, var other => throw new ValidationException($"`status` só pode passar a completed ou cancelled (recebido '{other}').", "/status") }
            : null;

        if (closing is { } status)
        {
            var closed = await CloseAsync(plan, status, ct);
            return await plans.SaveAsync(closed, ct);
        }

        // o que o servidor gere não se altera por PATCH
        var merged = MergePatch.Apply(plan, patch) with { Status = plan.Status, StatusHistory = plan.StatusHistory, Author = plan.Author, ActivatedAt = plan.ActivatedAt, CompletedAt = plan.CompletedAt };
        (merged, var routedMerged) = await router.ApplyWithKeysAsync(merged, ct);
        merged = await interventions.RefreshResourceEffectsAsync(plan, merged, ct);
        merged = merged with { Validation = await validator.ValidateAsync(merged, ct, routedMerged) };
        if (merged.Validation.Issues.Any(i => i.Severity == "error")) throw new ValidationException(merged.Validation.Issues);
        return await plans.SaveAsync(merged, ct);
    }

    // ===================================================================================================== escolher, ativar, fechar
    /// <summary>O operador escolhe este plano: os outros que partiram da mesma simulação (ou cenário) ficam descartados.</summary>
    public async Task<Plan> SelectAsync(string id, CancellationToken ct = default)
    {
        var plan = await Require(id, PlanStatus.Proposed, ct);
        foreach (var other in (await plans.ListAsync(p => p.Id != id && p.Status == PlanStatus.Proposed && p.LocationId == plan.LocationId && SameBasis(p, plan), ct)))
            await plans.SaveAsync(Transition(other, PlanStatus.Discarded), ct);
        return await plans.SaveAsync(Transition(plan, PlanStatus.Selected), ct);
    }

    static bool SameBasis(Plan a, Plan b) =>
        a.Basis?.SimulationId is { } s ? s == b.Basis?.SimulationId : a.Basis?.ScenarioId is { } sc && sc == b.Basis?.ScenarioId;

    /// <summary>Ativa o plano: um despacho por cada viatura e grupo de pessoal, um corte por cada ação de fecho de estrada. Tudo ou nada.</summary>
    public async Task<Plan> ActivateAsync(string id, CancellationToken ct = default)
    {
        var plan = await Require(id, PlanStatus.Selected, ct);
        // a plan still selected owns no live dispatch: any left by an activation that failed half-way is cancelled before trying again
        await CancelDispatchesAsync(plan.Id, ct);
        // a vehicle the plan gives several jobs (attack the head, then defend a village) is dispatched once, to its first job by time:
        // the dispatcher refuses the same vehicle twice in one batch, and its later jobs stay on the plan
        var start = plan.Basis?.SituationAsOf ?? clock.GetUtcNow();
        var assignments = plan.Actions
            .Select((a, order) => (Action: a, Order: order, At: a.Trigger is AtTimeTrigger t ? t.At.MinutesFrom(start) : 0))
            .OrderBy(x => x.At).ThenBy(x => x.Order)
            .SelectMany(x => (x.Action.Resources ?? new()).Where(r => r.ResourceType != ResourceType.Equipment).Select(r => (x.Action, Resource: r)))
            .DistinctBy(x => x.Resource.ResourceType == ResourceType.Vehicle ? $"vehicle:{x.Resource.ResourceId}" : $"{x.Action.Id}:{x.Resource.ResourceType}:{x.Resource.ResourceId}")
            .ToList();
        var batch = new DispatchBatch(assignments.Select(x => ToDispatch(x.Action, x.Resource)).ToList(), $"Plano {plan.Title}");

        var check = await dispatching.ValidateAsync(batch, ct);
        if (!check.Valid) throw new ConflictException("Não é possível ativar: " + string.Join("; ", check.Issues.Where(i => i.Severity == "error").Select(i => i.Message)), "resources_unavailable");
        await dispatching.CreateAsync(batch, new DispatchOrigin(DispatchSource.PlanAction, plan.Id, assignments.Select(x => (string?)x.Action.Id).ToList()), ct);

        var opened = new List<RoadClosure>();
        try
        {
            var actions = new List<PlanAction>();
            foreach (var a in plan.Actions)
            {
                if (a is not RoadClosureAction c) { actions.Add(a); continue; }
                var closure = await OpenClosure(plan, c, ct);
                opened.Add(closure);
                actions.Add(c with { ClosureId = closure.Id });
            }
            return await plans.SaveAsync(Transition(plan with { Actions = actions, ActivatedAt = clock.GetUtcNow() }, PlanStatus.Active), ct);
        }
        catch
        {
            // all or nothing: undo what this activation made, so the plan stays selected with its vehicles free and no road cut
            await CancelDispatchesAsync(plan.Id, CancellationToken.None);
            foreach (var closure in opened) await closures.DeleteAsync(closure.Id, CancellationToken.None);
            throw;
        }
    }

    async Task CancelDispatchesAsync(string planId, CancellationToken ct)
    {
        foreach (var d in await dispatches.ListAsync(d => d.PlanId == planId && d.IsActive, ct)) await dispatching.CancelAsync(d, ct);
    }

    static DispatchInput ToDispatch(PlanAction action, ResourceAssignment r) => new(r.ResourceType, r.ResourceId, r.Personnel ?? 1, r.Responsibility ?? DefaultResponsibility(action),
        TargetOf(action), r.FromStationId, null, action.ExpectedDurationMinutes, r.Route, r.Notes ?? action.Title);

    static Responsibility DefaultResponsibility(PlanAction a) => a switch
    {
        FireAttackAction or DispatchUnitsAction => Responsibility.Firefighting, StructureProtectionAction => Responsibility.StructureProtection, EvacuationAction or ShelterInPlaceAction => Responsibility.Evacuation,
        TrafficControlPointAction or RoadClosureAction => Responsibility.TrafficControl, MedicalStandbyAction => Responsibility.Medical, EstablishCommandPostAction => Responsibility.Command,
        ReconnaissanceAction => Responsibility.Reconnaissance, StageResourcesAction => Responsibility.Standby, _ => Responsibility.Logistics,
    };

    /// <summary>Onde atua uma ação (para o alvo dos despachos): o que cada tipo de ação tem de "sítio".</summary>
    public static Target TargetOf(PlanAction a) => a switch
    {
        DispatchUnitsAction d => d.Target, StageResourcesAction s => s.StagingArea, EstablishCommandPostAction e => e.Location,
        TrafficControlPointAction t => new Target(Label: a.Title, Position: t.Position, RoadId: t.RoadId), StructureProtectionAction p => p.Targets.FirstOrDefault() ?? new Target(Label: a.Title),
        FireAttackAction f => new Target(Label: a.Title, Position: f.AnchorPoint, Geometry: f.Line), AirSupportRequestAction air => air.TargetArea, ReconnaissanceAction r => r.Area,
        MedicalStandbyAction m => m.Positions?.FirstOrDefault() ?? new Target(Label: a.Title, Position: m.CasualtyCollectionPoint), EvacuationAction ev => new Target(Label: a.Title, Geometry: ev.Area),
        ShelterInPlaceAction sh => new Target(Label: a.Title, Geometry: sh.Area), RoadClosureAction c => new Target(Label: a.Title, RoadId: c.RoadIds.FirstOrDefault(), Geometry: c.Geometry),
        _ => new Target(Label: a.Title),
    };

    async Task<RoadClosure> OpenClosure(Plan plan, RoadClosureAction c, CancellationToken ct)
    {
        var start = clock.GetUtcNow();
        // the plan's clock starts when it is activated (T+0): an `until` of T+260 ends 260 min after activation, not after the scenario's
        // start (an exercise can be months old, which made every closure end before it began); an absolute end already past is left open
        DateTimeOffset? end = c.Until is { OffsetMinutes: { } minutes } ? start.AddMinutes(minutes) : c.Until?.Time is { } at && at > start ? at : null;
        return await closures.CreateAsync(new RoadClosure
        {
            LocationId = plan.LocationId, RoadIds = c.RoadIds, Geometry = c.Geometry, Kind = c.Kind, Reason = c.Reason, Status = ClosureStatus.Active, Start = start,
            End = end, Detour = c.Detour, Checkpoints = c.Checkpoints, Exemptions = c.Exemptions, ResponsibleOrganizationId = c.OrganizationId,
            Source = "plan_action", PlanActionRef = new PlanActionRef(plan.Id, c.Id),
        }, ct);
    }

    /// <summary>Fecha o plano: cancela os despachos que criou e levanta os cortes de estrada.</summary>
    async Task<Plan> CloseAsync(Plan plan, PlanStatus status, CancellationToken ct)
    {
        await CancelDispatchesAsync(plan.Id, ct);
        foreach (var c in await closures.ListAsync(c => c.PlanActionRef?.PlanId == plan.Id && c.Status == ClosureStatus.Active, ct)) await closures.SaveAsync(c with { Status = ClosureStatus.Lifted, End = clock.GetUtcNow() }, ct);
        return Transition(plan with { CompletedAt = clock.GetUtcNow() }, status);
    }

    Plan Transition(Plan plan, PlanStatus status) => plan with { Status = status, StatusHistory = (plan.StatusHistory ?? new()).Append(new PlanStatusChange(status, clock.GetUtcNow())).ToList() };

    async Task<Plan> Require(string id, PlanStatus expected, CancellationToken ct)
    {
        var plan = await plans.GetAsync(id, ct);
        return plan.Status == expected ? plan : throw new ConflictException($"O plano está '{EnumText.ToSnake(plan.Status)}'; precisa de estar '{EnumText.ToSnake(expected)}'.", "invalid_transition");
    }

    // ===================================================================================================== simular
    /// <summary>Corre a simulação do fogo com o plano aplicado (what-if) sobre o cenário em que o plano se baseia.</summary>
    public async Task<Simulation> SimulateAsync(string id, PlanSimulationRequest request, CancellationToken ct = default)
    {
        var plan = await plans.GetAsync(id, ct);
        var baselineId = request.BaselineSimulationId ?? plan.Basis?.SimulationId;
        var scenarioId = plan.Basis?.ScenarioId;
        Scenario? snapshot = null;
        if (scenarioId is null)
        {
            var baseline = baselineId is null ? null : await simulationStore.GetAsync(baselineId, ct);
            snapshot = baseline?.ScenarioSnapshot ?? throw new ValidationException("O plano não indica o cenário (`basis.scenarioId`) nem uma simulação de base.", "/basis");
        }
        return await simulations.CreateAsync(new SimulationRequest(scenarioId, snapshot, request.Label ?? $"Plano {plan.Variant ?? plan.Title}", SimulationKind.WhatIf, plan.Id, false, request.Engine), baselineId, ct);
    }

    // ===================================================================================================== ações
    public async Task<IReadOnlyList<PlanAction>> ActionsAsync(string planId, CancellationToken ct = default) => (await plans.GetAsync(planId, ct)).Actions;

    public async Task<PlanAction> ActionAsync(string planId, string actionId, CancellationToken ct = default) =>
        (await ActionsAsync(planId, ct)).FirstOrDefault(a => a.Id == actionId) ?? throw new NotFoundException($"Ação '{actionId}'");

    /// <summary>Quem executa confirma, inicia, conclui ou bloqueia uma ação.</summary>
    public async Task<PlanAction> UpdateActionAsync(string planId, string actionId, ActionPatch patch, CancellationToken ct = default)
    {
        var plan = await plans.GetAsync(planId, ct);
        if (plan.Status != PlanStatus.Active) throw new ConflictException("Só as ações de planos ativos se atualizam.", "invalid_transition");
        var action = plan.Actions.FirstOrDefault(a => a.Id == actionId) ?? throw new NotFoundException($"Ação '{actionId}'");

        var now = clock.GetUtcNow(); var progress = action.Progress ?? new ActionProgress();
        var status = patch.Status ?? action.Status;
        progress = progress with
        {
            Note = patch.Note ?? progress.Note,
            AcknowledgedAt = progress.AcknowledgedAt ?? (status is ActionStatus.Acknowledged or ActionStatus.InProgress or ActionStatus.Completed ? now : null),
            StartedAt = patch.StartedAt ?? progress.StartedAt ?? (status is ActionStatus.InProgress or ActionStatus.Completed ? now : null),
            CompletedAt = patch.CompletedAt ?? progress.CompletedAt ?? (status is ActionStatus.Completed ? now : null),
        };
        var updated = action with { Status = status, Progress = progress, Resources = patch.Resources ?? action.Resources };
        await plans.SaveAsync(plan with { Actions = plan.Actions.Select(a => a.Id == actionId ? updated : a).ToList() }, ct);
        return updated;
    }

    /// <summary>A lista de trabalho: ações de planos ativos (ou do estado pedido), por prioridade.</summary>
    public async Task<IReadOnlyList<TaskItem>> TasksAsync(Func<Plan, bool> planFilter, Func<PlanAction, bool> actionFilter, CancellationToken ct = default) =>
        (await plans.ListAsync(planFilter, ct)).SelectMany(p => p.Actions.Where(actionFilter).Select(a => new TaskItem(p.Id, p.Title, p.Status, a)))
            .OrderBy(t => t.Action.Priority).ThenBy(t => t.PlanId).ToList();
}
