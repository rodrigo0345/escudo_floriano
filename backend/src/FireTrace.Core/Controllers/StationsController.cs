using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Resources;

namespace FireTrace.Core.Controllers;

/// <summary>Postos (quartéis, esquadras, bases).</summary>
[Route("/api/v1/stations")]
public sealed class StationsController(CrudService<Station> service, OwnerFilter owners) : DeletableCrudController<Station>(service)
{
    protected override async Task<Func<Station, bool>?> FilterAsync(Query q, CancellationToken ct) =>
        Filters.All(
            await owners.BuildAsync<Station>(q.Owner(), s => s.OrganizationId, s => s.Id, ct),
            Filters.When<Station, StationKind>(q.Enums<StationKind>("kind"), s => s.Kind),
            Filters.When<Station, StationStatus>(q.Enums<StationStatus>("status"), s => s.Status));
}
