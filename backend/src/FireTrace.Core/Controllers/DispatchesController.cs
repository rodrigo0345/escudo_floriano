using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Controllers.Filtering;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Services.Crud;
using FireTrace.Core.Services.Operations;
using FireTrace.Core.Services.Resources;
using FireTrace.ExternalData.Store;
using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace FireTrace.Core.Controllers;

/// <summary>Despachos: ordenar meios com pessoas e uma responsabilidade, e acompanhar o que cada um está a fazer.</summary>
[Route("/api/v1/dispatches")]
public sealed class DispatchesController(DispatchService service, CrudService<Dispatch> dispatches, OwnerFilter owners) : ApiController
{
    [HttpGet]
    public async Task<ActionResult<Page<Dispatch>>> List([FromQuery] Query q, [FromQuery] PageQuery page, CancellationToken ct)
    {
        var statuses = q.Enums<DispatchStatus>("status");
        var responsibilities = q.Enums<Responsibility>("responsibility");
        bool includeFinished = q.Bool("includeFinished") == true;
        var owned = await owners.BuildAsync<Dispatch>(q.Owner(), d => d.OrganizationId, d => d.FromStationId, ct);
        var filter = Filters.All(owned,
            Filters.When<Dispatch, DispatchStatus>(statuses, d => d.Status), Filters.When<Dispatch, Responsibility>(responsibilities, d => d.Responsibility),
            Filters.When<Dispatch>(q.Str("resourceId"), d => d.ResourceId), Filters.When<Dispatch>(q.Str("planId"), d => d.PlanId),
            d => includeFinished || statuses.Count > 0 || d.IsActive);
        return Ok(await dispatches.PageAsync(page, filter, ct));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] DispatchBatch body, CancellationToken ct) => Created($"{Base}/dispatches", await service.CreateAsync(body, ct: ct));

    [HttpPost("validate")]
    public async Task<ActionResult<DispatchValidation>> Validate([FromBody] DispatchBatch body, CancellationToken ct) => Ok(await service.ValidateAsync(body, ct));

    [HttpGet("{id}")]
    public async Task<ActionResult<Dispatch>> Get(string id, CancellationToken ct) => Ok(await dispatches.GetAsync(id, ct));

    [HttpPatch("{id}")]
    public async Task<ActionResult<Dispatch>> Patch(string id, [FromBody] DispatchPatch body, CancellationToken ct) => Ok(await service.PatchAsync(id, body, ct));

    [HttpPost("{id}/recall")]
    public async Task<ActionResult<Dispatch>> Recall(string id, [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] DispatchRecall? body, CancellationToken ct) =>
        Ok(await service.RecallAsync(id, body ?? new DispatchRecall(), ct));
}
