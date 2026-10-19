using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Resources;

namespace FireTrace.Core.Controllers;

/// <summary>Equipamento por posto.</summary>
[Route("/api/v1/equipment")]
public sealed class EquipmentController(CrudService<Equipment> service, OwnerFilter owners) : DeletableCrudController<Equipment>(service)
{
    protected override async Task<Func<Equipment, bool>?> FilterAsync(Query q, CancellationToken ct) =>
        Filters.All(
            await owners.BuildAsync<Equipment>(q.Owner(), e => e.OrganizationId, e => e.StationId, ct),
            Filters.When<Equipment, EquipmentKind>(q.Enums<EquipmentKind>("kind"), e => e.Kind));
}
