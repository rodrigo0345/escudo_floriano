using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Services.Operations;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.RateLimiting;

namespace FireTrace.Core.Controllers;

/// <summary>Pedidos de planos aos agentes: a interface pede e acompanha, o serviço dos agentes reclama, relata e fecha.</summary>
[Route("/api/v1/plan-requests")]
public sealed class PlanRequestsController(PlanRequestService service) : ApiController
{
    [HttpPost("/api/v1/simulations/{simulationId}/plan-requests")]
    [EnableRateLimiting("planning-light")]
    public async Task<ActionResult<PlanRequest>> Create(string simulationId, [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] PlanRequestInput? body, CancellationToken ct)
    {
        var (request, created) = await service.CreateAsync(simulationId, body ?? new PlanRequestInput(), ct);
        return created ? StatusCode(StatusCodes.Status202Accepted, request) : Ok(request);
    }

    [HttpGet]
    public async Task<ActionResult<Page<PlanRequest>>> List([FromQuery] Query q, [FromQuery] PageQuery page, CancellationToken ct) =>
        Ok(await service.PageAsync(page, Filters.All(
            Filters.When<PlanRequest>(q.Str("simulationId"), r => r.SimulationId), Filters.When<PlanRequest, PlanRequestStatus>(q.Enums<PlanRequestStatus>("status"), r => r.Status)), ct));

    [HttpGet("{id}")]
    public async Task<ActionResult<PlanRequest>> Get(string id, CancellationToken ct) => Ok(await service.GetAsync(id, ct));

    [HttpPatch("{id}")]
    public async Task<ActionResult<PlanRequest>> Patch(string id, [FromBody] PlanRequestPatch body, CancellationToken ct) => Ok(await service.PatchAsync(id, body, ct));

    [HttpPost("{id}/claim")]
    [EnableRateLimiting("planning-light")]
    public async Task<ActionResult<PlanRequest>> Claim(string id, [FromBody] PlanRequestClaim body, CancellationToken ct) => Ok(await service.ClaimAsync(id, body, ct));
}
