using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Repositories;

namespace FireTrace.Core.Services.Policies;

public sealed class PersonnelPoolPolicy(IDocumentStore<Organization> organizations, IDocumentStore<Station> stations) : ReferencingPolicy<PersonnelPool>("pp", organizations, stations)
{
    public override Task<IEnumerable<ValidationIssue>> ValidateAsync(PersonnelPool p, CancellationToken ct) => Collect(async issues =>
    {
        await RequireOrganization(p.OrganizationId, issues, ct);
        await RequireStation(p.StationId, issues, ct);
        if (p.Total < 0 || p.Available < 0) issues.Add(new("error", "invalid_count", "total e available não podem ser negativos.", "/total"));
        if (p.Available + p.Deployed > p.Total) issues.Add(new("error", "invalid_count", "available + deployed excede total.", "/available"));
    });
}
