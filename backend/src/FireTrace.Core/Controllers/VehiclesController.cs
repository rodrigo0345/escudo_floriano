using System.Text.Json;
using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Resources;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Resources;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Controllers;

/// <summary>Viaturas e o seu estado (que muda muitas vezes, por isso tem rotas próprias).</summary>
[Route("/api/v1/vehicles")]
public sealed class VehiclesController(CrudService<Vehicle> service, VehicleFilter filter, VehicleStateService states) : DeletableCrudController<Vehicle>(service)
{
    protected override async Task<Func<Vehicle, bool>?> FilterAsync(Query q, CancellationToken ct) =>
        await filter.BuildAsync(new VehicleQuery(q.Owner(), q.Enums<VehicleType>("type"), q.Enums<VehicleStatus>("status"), q.Enums<Responsibility>("responsibility"),
            q.Enums<VehicleCapability>("capability"), q.Bool("offRoad"), q.Bool("inService"), q.Point("near"), q.Dbl("radiusM")), ct);

    [HttpGet("{id}/state")]
    public async Task<ActionResult<VehicleState>> GetState(string id, CancellationToken ct) => Ok(await states.GetAsync(id, ct));

    [HttpPatch("{id}/state")]
    public async Task<ActionResult<VehicleState>> PatchState(string id, [FromBody] JsonElement patch, CancellationToken ct) => Ok(await states.PatchAsync(id, patch, ct));
}
