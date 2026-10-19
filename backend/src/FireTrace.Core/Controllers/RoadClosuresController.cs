using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Services.Crud;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers;

/// <summary>Cortes de estrada. Nunca se apagam: levantam-se (estado `lifted`) para ficar no registo.</summary>
[Route("/api/v1/road-closures")]
public sealed class RoadClosuresController(CrudService<RoadClosure> service) : CrudController<RoadClosure>(service)
{
    protected override Task<Func<RoadClosure, bool>?> FilterAsync(Query q, CancellationToken ct)
    {
        var statuses = q.Enums<ClosureStatus>("status");
        var activeAt = q.Time("activeAt");
        return Task.FromResult<Func<RoadClosure, bool>?>(Filters.All(
            Filters.When<RoadClosure>(q.Str("locationId"), c => c.LocationId),
            Filters.When<RoadClosure>(q.Str("source"), c => c.Source),
            Filters.When<RoadClosure>(q.Str("organizationId"), c => c.ResponsibleOrganizationId),
            Filters.When<RoadClosure, ClosureStatus>(statuses, c => c.Status),
            c => activeAt is not { } t || (c.Status == ClosureStatus.Active && c.Start <= t && (c.End is null || c.End > t))));
    }
}
