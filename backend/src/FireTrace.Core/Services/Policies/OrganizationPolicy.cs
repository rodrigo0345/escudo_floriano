using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Crud;

namespace FireTrace.Core.Services.Policies;

public sealed class OrganizationPolicy(IDocumentStore<Organization> organizations, IDocumentStore<Station> stations, IDocumentStore<Vehicle> vehicles) : EntityPolicy<Organization>("org")
{
    public override async Task<IEnumerable<ValidationIssue>> ValidateAsync(Organization o, CancellationToken ct)
    {
        var issues = new List<ValidationIssue>();
        if (o.ParentOrganizationId is { } parent && (parent == o.Id || await organizations.GetAsync(parent, ct) is null))
            issues.Add(new("error", "unknown_organization", $"Organização-mãe '{parent}' inválida.", "/parentOrganizationId"));
        return issues;
    }

    public override void EnsureDeletable(Organization o)
    {
        if (stations.ListAsync().Result.Any(s => s.OrganizationId == o.Id) || vehicles.ListAsync().Result.Any(v => v.OrganizationId == o.Id))
            throw new ConflictException("A organização ainda tem postos ou viaturas; apague-os primeiro.", "organization_in_use");
    }
}
