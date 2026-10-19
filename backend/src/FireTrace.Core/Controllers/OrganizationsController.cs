using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Services.Crud;

namespace FireTrace.Core.Controllers;

/// <summary>Organizações (GNR, bombeiros, INEM…).</summary>
[Route("/api/v1/organizations")]
public sealed class OrganizationsController(CrudService<Organization> service) : DeletableCrudController<Organization>(service)
{
    protected override Task<Func<Organization, bool>?> FilterAsync(Query q, CancellationToken ct) =>
        Task.FromResult<Func<Organization, bool>?>(Filters.All(
            Filters.When<Organization, OrganizationType>(q.Enums<OrganizationType>("type"), o => o.Type),
            Filters.When<Organization>(q.Bool("active"), o => o.Active)));
}
