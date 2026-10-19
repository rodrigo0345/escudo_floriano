using FireTrace.Core.Models.Routing;
using FireTrace.Core.Services.Routing;

namespace FireTrace.Core.Controllers;

/// <summary>Rotas e tempos de acesso que respeitam os cortes de estrada e o fogo previsto.</summary>
[Route("/api/v1/routing")]
public sealed class RoutingController(RoutingService routing) : ApiController
{
    [HttpPost("route")]
    public async Task<ActionResult<RoutePlan>> Route([FromBody] RouteRequest body, CancellationToken ct) => Ok(await routing.RouteAsync(body, ct));

    [HttpPost("access")]
    public async Task<ActionResult<AccessMatrix>> Access([FromBody] AccessRequest body, CancellationToken ct) => Ok(await routing.AccessAsync(body, ct));
}
