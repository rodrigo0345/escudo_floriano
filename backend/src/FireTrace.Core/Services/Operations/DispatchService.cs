using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Models.Routing;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Routing;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>Despachar meios com pessoas e uma responsabilidade: valida tudo antes de executar (atómico), mantém o estado dos meios em sincronia e permite reatribuir ou chamar de volta.</summary>
public sealed class DispatchService(CrudService<Dispatch> dispatches, IEnumerable<IResourceDispatcher> dispatcherList, ArrivalEstimator arrival, TargetResolver targets, TimeProvider clock)
{
    readonly Dictionary<ResourceType, IResourceDispatcher> _dispatchers = dispatcherList.ToDictionary(d => d.Type);

    sealed record Prepared(DispatchInput Input, IResourceDispatcher Dispatcher, DispatchSubject Subject, double? Eta, LineString? Route);

    IResourceDispatcher For(ResourceType type) => _dispatchers.TryGetValue(type, out var d) ? d : throw new ValidationException($"Não se despacham meios do tipo '{EnumText.ToSnake(type)}'.", "/resourceType");

    // ===================================================================================================== validar e criar
    public async Task<DispatchValidation> ValidateAsync(DispatchBatch batch, CancellationToken ct = default)
    {
        var (prepared, issues) = await PrepareAsync(batch.Dispatches, ct);
        return new DispatchValidation(issues.All(i => i.Severity != "error"), issues, prepared.Select(p => new DispatchEta(p.Input.ResourceId, p.Eta)).ToList());
    }

    public async Task<DispatchResult> CreateAsync(DispatchBatch batch, DispatchOrigin? origin = null, CancellationToken ct = default)
    {
        origin ??= new DispatchOrigin();
        var (prepared, issues) = await PrepareAsync(batch.Dispatches, ct);
        if (issues.Any(i => i.Severity == "error")) throw new ValidationException(issues);

        var created = new List<Dispatch>();
        for (int i = 0; i < prepared.Count; i++)
        {
            var (input, dispatcher, subject, eta, route) = prepared[i];
            var dispatch = await dispatches.CreateAsync(new Dispatch
            {
                OrganizationId = subject.OrganizationId, ResourceType = input.ResourceType, ResourceId = input.ResourceId, Personnel = input.Personnel, Responsibility = input.Responsibility,
                Target = input.Target, FromStationId = input.FromStationId ?? subject.StationId, StartAt = input.StartAt ?? clock.GetUtcNow(), ExpectedDurationMinutes = input.ExpectedDurationMinutes,
                Route = route ?? input.Route, // a rota calculada pelo servidor (por estrada) prevalece sobre a do cliente Notes = input.Notes, Status = DispatchStatus.Ordered, EtaMinutes = eta, Position = subject.Position,
                CrewOnboard = input.ResourceType == ResourceType.Vehicle ? input.Personnel : null, Source = origin.Source, PlanId = origin.PlanId,
                ActionId = origin.ActionIds is { } ids && i < ids.Count ? ids[i] : null, Reason = batch.Reason,
            }, ct);
            await dispatcher.AssignAsync(dispatch, ct);
            created.Add(dispatch);
        }
        return new DispatchResult(created, issues);
    }

    async Task<(List<Prepared> Prepared, List<ValidationIssue> Issues)> PrepareAsync(IReadOnlyList<DispatchInput> inputs, CancellationToken ct)
    {
        var issues = new List<ValidationIssue>(); var prepared = new List<Prepared>(); var used = new Dictionary<(ResourceType, string), int>();
        for (int i = 0; i < inputs.Count; i++)
        {
            var input = inputs[i]; string at = $"/dispatches/{i}";
            void Add(ValidationIssue issue) => issues.Add(issue with { Pointer = at + issue.Pointer, ResourceId = input.ResourceId });
            if (!_dispatchers.TryGetValue(input.ResourceType, out var dispatcher)) { Add(new("error", "unsupported_resource", $"Não se despacham meios do tipo '{EnumText.ToSnake(input.ResourceType)}'.", "/resourceType")); continue; }
            if (await dispatcher.FindAsync(input.ResourceId, ct) is not { } subject) { Add(new("error", "unknown_resource", $"Meio '{input.ResourceId}' desconhecido.", "/resourceId")); continue; }
            if (input.Target.IsEmpty) Add(new("error", "empty_target", "Indique onde o meio vai atuar (`target`).", "/target"));

            used.TryGetValue((input.ResourceType, input.ResourceId), out var before);
            foreach (var issue in dispatcher.Check(subject, input, before)) Add(issue);
            used[(input.ResourceType, input.ResourceId)] = before + input.Personnel;

            var (eta, route, problem) = await ArrivalAsync(subject, input, ct);
            if (problem is not null) Add(problem);
            if (input.Route is { } sent && subject.Vehicle is { } vehicle && !ArrivalEstimator.IsAerial(vehicle.Type) && arrival.LocationOf(new LatLon(sent.Coordinates[^1].Y, sent.Coordinates[^1].X), subject.LocationId) is { } routeLocation
                && await arrival.CheckRouteAsync(sent, routeLocation, "/route", ct) is { } offNetwork)
                Add(offNetwork with { Severity = "warning", Code = "route_replaced", Message = offNetwork.Message + " O servidor usa a sua rota por estrada." }); // a rota guardada é sempre a calculada pelo servidor
            prepared.Add(new Prepared(input, dispatcher, subject, eta, route));
        }
        return (prepared, issues);
    }

    /// <summary>Quanto demora a chegar ao alvo (por estrada e a pé nas pontas, ou em linha reta se for um meio aéreo) e por onde.</summary>
    async Task<(double? Eta, LineString? Route, ValidationIssue? Problem)> ArrivalAsync(DispatchSubject s, DispatchInput input, CancellationToken ct)
    {
        if (input.Target.IsEmpty) return (null, null, null);
        var to = await targets.PositionAsync(input.Target, s.LocationId, ct);
        if (to is null) return (null, null, new("error", "target_not_found", "Não foi possível localizar o alvo.", "/target"));
        if (s.Position is not { } from) return (null, null, new("warning", "unknown_position", "A posição de partida do meio não é conhecida; sem chegada estimada."));

        var a = await arrival.EstimateAsync(s.Vehicle, from, to, s.LocationId, input.StartAt, ct);
        return (a.Minutes, a.Route, a.Problem);
    }

    // ===================================================================================================== alterar e chamar de volta
    public async Task<Dispatch> PatchAsync(string id, DispatchPatch patch, CancellationToken ct = default)
    {
        var current = await ActiveAsync(id, ct);
        var dispatcher = For(current.ResourceType);
        var updated = current with
        {
            Responsibility = patch.Responsibility ?? current.Responsibility, Personnel = patch.Personnel ?? current.Personnel, Target = patch.Target ?? current.Target,
            Status = patch.Status ?? current.Status, Notes = patch.Notes ?? current.Notes,
        };
        if (patch.Target is { IsEmpty: true }) throw new ValidationException("O alvo não pode ficar vazio.", "/target");
        if (patch.Target is not null && await dispatcher.FindAsync(current.ResourceId, ct) is { } mover
            && (await ArrivalAsync(mover, new DispatchInput(updated.ResourceType, updated.ResourceId, updated.Personnel, updated.Responsibility, updated.Target), ct)).Problem is { Severity: "error" } unreachable)
            throw new ValidationException(new[] { unreachable }); // o novo alvo também tem de ser alcançável por estrada

        bool regroup = updated.Personnel != current.Personnel || updated.Responsibility != current.Responsibility;
        if (regroup)
        {
            await dispatcher.ReleaseAsync(current, ct);
            var subject = await dispatcher.FindAsync(current.ResourceId, ct) ?? throw new NotFoundException($"Meio '{current.ResourceId}'");
            var issues = dispatcher.Check(subject, new DispatchInput(updated.ResourceType, updated.ResourceId, updated.Personnel, updated.Responsibility, updated.Target), 0).Where(i => i.Severity == "error").ToList();
            if (issues.Count > 0) { await dispatcher.AssignAsync(current, ct); throw new ValidationException(issues); }
            await dispatcher.AssignAsync(updated, ct);
        }
        return await Apply(updated, dispatcher, ct);
    }

    public async Task<Dispatch> RecallAsync(string id, DispatchRecall recall, CancellationToken ct = default)
    {
        var current = await ActiveAsync(id, ct);
        // viaturas voltam ao posto (ficam livres quando chegam); pessoal a pé fica livre logo
        var next = current.ResourceType == ResourceType.Vehicle ? DispatchStatus.Returning : DispatchStatus.Completed;
        return await Apply(current with { Status = next, Reason = recall.Reason ?? current.Reason }, For(current.ResourceType), ct);
    }

    /// <summary>Cancela um despacho (usado quando um plano se fecha).</summary>
    public async Task CancelAsync(Dispatch d, CancellationToken ct = default) => await Apply(d with { Status = DispatchStatus.Cancelled }, For(d.ResourceType), ct);

    async Task<Dispatch> Apply(Dispatch d, IResourceDispatcher dispatcher, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        if (d.Status is DispatchStatus.OnScene or DispatchStatus.Working && d.ArrivedAt is null) d = d with { ArrivedAt = now };
        bool finished = !d.IsActive;
        if (finished) d = d with { CompletedAt = now };
        var saved = await dispatches.SaveAsync(d, ct);
        if (finished) await dispatcher.ReleaseAsync(saved, ct); else await dispatcher.SyncAsync(saved, ct);
        return saved;
    }

    async Task<Dispatch> ActiveAsync(string id, CancellationToken ct)
    {
        var d = await dispatches.GetAsync(id, ct);
        return d.IsActive ? d : throw new ConflictException($"O despacho já terminou ({EnumText.ToSnake(d.Status)}).", "dispatch_finished");
    }
}
