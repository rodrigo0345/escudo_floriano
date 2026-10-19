using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Crud;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

public sealed class PersonnelDispatcher(IDocumentStore<PersonnelPool> store, CrudService<PersonnelPool> pools, IDocumentStore<Station> stations) : IResourceDispatcher
{
    public ResourceType Type => ResourceType.PersonnelPool;

    public async Task<DispatchSubject?> FindAsync(string id, CancellationToken ct)
    {
        if (await store.GetAsync(id, ct) is not { } p) return null;
        var station = p.StationId is { } sid ? await stations.GetAsync(sid, ct) : null;
        return new DispatchSubject(p.Id, p.OrganizationId, p.StationId, station?.LocationId, station?.Position, Available: p.Available);
    }

    public IEnumerable<ValidationIssue> Check(DispatchSubject s, DispatchInput input, int alreadyInBatch)
    {
        if (input.Personnel > s.Available - alreadyInBatch)
            yield return new("error", "not_enough_personnel", $"Só há {s.Available - alreadyInBatch} pessoas livres neste grupo (pedidas {input.Personnel}).", "/personnel");
    }

    public async Task AssignAsync(Dispatch d, CancellationToken ct) => await Move(d, +1, ct);
    public Task SyncAsync(Dispatch d, CancellationToken ct) => Task.CompletedTask;
    public async Task ReleaseAsync(Dispatch d, CancellationToken ct) => await Move(d, -1, ct);

    /// <summary>Passa `d.Personnel` pessoas de livres para despachadas (sinal +1) ou de volta (sinal −1), registando-as por responsabilidade.</summary>
    async Task Move(Dispatch d, int sign, CancellationToken ct)
    {
        var pool = await pools.GetAsync(d.ResourceId, ct);
        int n = sign * d.Personnel;
        var deployments = (pool.Deployments ?? new()).ToList();
        int at = deployments.FindIndex(x => x.Responsibility == d.Responsibility);
        int now = (at >= 0 ? deployments[at].Personnel : 0) + n;
        if (at >= 0) deployments.RemoveAt(at);
        if (now > 0) deployments.Add(new Deployment(d.Responsibility, now));
        await pools.SaveAsync(pool with { Available = pool.Available - n, Deployed = Math.Max(0, pool.Deployed + n), Deployments = deployments.Count == 0 ? null : deployments }, ct);
    }
}
