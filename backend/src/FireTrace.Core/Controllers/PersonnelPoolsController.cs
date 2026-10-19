using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Resources;

namespace FireTrace.Core.Controllers;

/// <summary>Grupos de pessoal por posto e função.</summary>
[Route("/api/v1/personnel-pools")]
public sealed class PersonnelPoolsController(CrudService<PersonnelPool> service, OwnerFilter owners) : DeletableCrudController<PersonnelPool>(service)
{
    protected override async Task<Func<PersonnelPool, bool>?> FilterAsync(Query q, CancellationToken ct) =>
        Filters.All(
            await owners.BuildAsync<PersonnelPool>(q.Owner(), p => p.OrganizationId, p => p.StationId, ct),
            Filters.When<PersonnelPool, PersonnelRole>(q.Enums<PersonnelRole>("role"), p => p.Role));
}
