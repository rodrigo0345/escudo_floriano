using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Services.Crud;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers;

/// <summary>Cenários: onde, quando, que meteorologia, que meios e que decisões se simulam.</summary>
[Route("/api/v1/scenarios")]
public sealed class ScenariosController(CrudService<Scenario> service) : DeletableCrudController<Scenario>(service)
{
    protected override Task<Func<Scenario, bool>?> FilterAsync(Query q, CancellationToken ct) =>
        Task.FromResult<Func<Scenario, bool>?>(Filters.All(
            Filters.When<Scenario>(q.Str("locationId"), s => s.LocationId),
            Filters.When<Scenario, ScenarioPurpose>(q.Enums<ScenarioPurpose>("purpose"), s => s.Purpose),
            Filters.When<Scenario>(q.Bool("builtin"), s => s.Builtin),
            s => q.Str("q") is not { } text || s.Name.Contains(text, StringComparison.OrdinalIgnoreCase)));
}
