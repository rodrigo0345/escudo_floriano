using System.Text.Json;
using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Operations;
using FireTrace.ExternalData.Store;
using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace FireTrace.Core.Controllers;

/// <summary>Planos de resposta (A e B) e as suas ações.</summary>
[Route("/api/v1/plans")]
public sealed class PlansController(PlanService service, CrudService<Plan> plans) : ApiController
{
    [HttpGet]
    public async Task<ActionResult<Page<PlanSummary>>> List([FromQuery] Query q, [FromQuery] PageQuery page, CancellationToken ct)
    {
        var filter = Filters.All(
            Filters.When<Plan>(q.Str("locationId"), p => p.LocationId), Filters.When<Plan>(q.Str("simulationId"), p => p.Basis?.SimulationId),
            Filters.When<Plan>(q.Str("scenarioId"), p => p.Basis?.ScenarioId),
            Filters.When<Plan>(q.Str("variant"), p => p.Variant), Filters.When<Plan, PlanStatus>(q.Enums<PlanStatus>("status"), p => p.Status),
            p => q.Str("organizationId") is not { } org || p.Actions.Any(a => a.OrganizationId == org || a.SupportingOrganizationIds?.Contains(org) == true));
        var result = await plans.PageAsync(page, filter, ct);
        return Ok(new Page<PlanSummary>(result.Items.Select(PlanSummary.Of).ToList(), result.NextCursor, result.Total));
    }

    [HttpPost]
    public async Task<ActionResult<Plan>> Create([FromBody] Plan body, CancellationToken ct)
    {
        var created = await service.CreateAsync(body, ct);
        return Created($"{Base}/plans/{created.Id}", created);
    }

    [HttpPost("validate")]
    public async Task<ActionResult<PlanValidation>> Validate([FromBody] Plan body, CancellationToken ct) => Ok(await service.ValidateAsync(body, ct));

    [HttpGet("{id}")]
    public async Task<ActionResult<Plan>> Get(string id, CancellationToken ct) => Ok(await plans.GetAsync(id, ct));

    [HttpPatch("{id}")]
    public async Task<ActionResult<Plan>> Patch(string id, [FromBody] JsonElement patch, CancellationToken ct) => Ok(await service.PatchAsync(id, patch, ct));

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        await plans.DeleteAsync(id, ct);
        return NoContent();
    }

    [HttpPost("{id}/select")]
    public async Task<ActionResult<Plan>> Select(string id, CancellationToken ct) => Ok(await service.SelectAsync(id, ct));

    [HttpPost("{id}/activate")]
    public async Task<ActionResult<Plan>> Activate(string id, CancellationToken ct) => Ok(await service.ActivateAsync(id, ct));

    /// <summary>"E se aplicarmos isto?": lança uma simulação com as ações do plano como intervenções.</summary>
    [HttpPost("{id}/simulate")]
    public async Task<ActionResult<Simulation>> Simulate(string id, [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] PlanSimulationRequest? body, CancellationToken ct)
    {
        var simulation = await service.SimulateAsync(id, body ?? new PlanSimulationRequest(), ct);
        Response.Headers.Location = $"{Base}/simulations/{simulation.Id}";
        return StatusCode(StatusCodes.Status202Accepted, simulation);
    }

    [HttpGet("{id}/actions")]
    public async Task<ActionResult<Page<PlanAction>>> Actions(string id, [FromQuery] PageQuery page, CancellationToken ct) => Ok(page.Apply(await service.ActionsAsync(id, ct)));

    [HttpGet("{id}/actions/{actionId}")]
    public async Task<ActionResult<PlanAction>> GetAction(string id, string actionId, CancellationToken ct) => Ok(await service.ActionAsync(id, actionId, ct));

    [HttpPatch("{id}/actions/{actionId}")]
    public async Task<ActionResult<PlanAction>> PatchAction(string id, string actionId, [FromBody] ActionPatch body, CancellationToken ct) =>
        Ok(await service.UpdateActionAsync(id, actionId, body, ct));
}
