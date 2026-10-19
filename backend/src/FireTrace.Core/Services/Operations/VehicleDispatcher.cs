using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Crud;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

public sealed class VehicleDispatcher(IDocumentStore<Vehicle> store, CrudService<Vehicle> vehicles, IDocumentStore<Station> stations, TimeProvider clock, ResponsibilityRules rules) : IResourceDispatcher
{
    public ResourceType Type => ResourceType.Vehicle;

    public async Task<DispatchSubject?> FindAsync(string id, CancellationToken ct)
    {
        if (await store.GetAsync(id, ct) is not { } v) return null;
        var station = v.StationId is { } sid ? await stations.GetAsync(sid, ct) : null;
        return new DispatchSubject(v.Id, v.OrganizationId, v.StationId, station?.LocationId, v.State.Position ?? station?.Position, v);
    }

    public IEnumerable<ValidationIssue> Check(DispatchSubject s, DispatchInput input, int alreadyInBatch)
    {
        var v = s.Vehicle!;
        if (alreadyInBatch > 0) yield return new("error", "duplicate_resource", $"A viatura {v.Callsign} aparece mais do que uma vez.");
        if (!v.InService) yield return new("error", "vehicle_out_of_service", $"A viatura {v.Callsign} está fora de serviço.");
        else if (v.State.Status != VehicleStatus.Available) yield return new("error", "vehicle_busy", $"A viatura {v.Callsign} não está livre (estado {EnumText.ToSnake(v.State.Status)}).");
        if (input.Personnel < (v.MinimumCrew ?? 1) || input.Personnel > v.CrewCapacity)
            yield return new("error", "crew_range", $"A viatura {v.Callsign} leva entre {v.MinimumCrew ?? 1} e {v.CrewCapacity} pessoas (pedidas {input.Personnel}).", "/personnel");
        if (!rules.Supports(input.Responsibility, v.Capabilities))
            yield return new("error", "responsibility_not_supported", $"A viatura {v.Callsign} não tem capacidades para '{EnumText.ToSnake(input.Responsibility)}'.", "/responsibility");
    }

    public Task AssignAsync(Dispatch d, CancellationToken ct) => SyncAsync(d, ct);

    public async Task SyncAsync(Dispatch d, CancellationToken ct)
    {
        var v = await vehicles.GetAsync(d.ResourceId, ct);
        var state = v.State with
        {
            Status = d.Status switch
            {
                DispatchStatus.Ordered => VehicleStatus.Dispatched, DispatchStatus.EnRoute => VehicleStatus.EnRoute, DispatchStatus.Refilling => VehicleStatus.Refilling,
                DispatchStatus.Returning => VehicleStatus.Returning, DispatchStatus.Resting or DispatchStatus.Grounded => VehicleStatus.Unavailable, _ => VehicleStatus.OnScene,
            },
            Responsibility = d.Responsibility, Target = d.Target, CurrentDispatchId = d.Id, CurrentPlanId = d.PlanId, CurrentActionId = d.ActionId, CrewOnboard = d.Personnel,
            Source = StateSource.System, UpdatedAt = clock.GetUtcNow(),
        };
        await vehicles.SaveAsync(v with { State = state }, ct);
    }

    public async Task ReleaseAsync(Dispatch d, CancellationToken ct)
    {
        var v = await vehicles.GetAsync(d.ResourceId, ct);
        var home = v.StationId is { } sid ? (await stations.GetAsync(sid, ct))?.Position : null;
        await vehicles.SaveAsync(v with { State = new VehicleState { Status = VehicleStatus.Available, Position = home ?? v.State.Position, Source = StateSource.System, UpdatedAt = clock.GetUtcNow() } }, ct);
    }
}
