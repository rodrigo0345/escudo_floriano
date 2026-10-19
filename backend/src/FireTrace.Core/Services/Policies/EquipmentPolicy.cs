using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Repositories;

namespace FireTrace.Core.Services.Policies;

public sealed class EquipmentPolicy(IDocumentStore<Organization> organizations, IDocumentStore<Station> stations) : ReferencingPolicy<Equipment>("eq", organizations, stations)
{
    public override Task<IEnumerable<ValidationIssue>> ValidateAsync(Equipment e, CancellationToken ct) => Collect(async issues =>
    {
        await RequireOrganization(e.OrganizationId, issues, ct);
        await RequireStation(e.StationId, issues, ct);
        if (e.Quantity < 0 || e.Available < 0) issues.Add(new("error", "invalid_count", "quantity e available não podem ser negativos.", "/quantity"));
        if (e.Available + e.InUse > e.Quantity) issues.Add(new("error", "invalid_count", "available + inUse excede quantity.", "/available"));
    });
}
