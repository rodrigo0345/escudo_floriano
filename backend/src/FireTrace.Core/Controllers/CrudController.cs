using System.Text.Json;
using FireTrace.Core.Controllers.Binding;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Services.Crud;

namespace FireTrace.Core.Controllers;

/// <summary>
/// The four endpoints every simple resource has (list, create, read, patch), written once. A derived controller only sets its route and,
/// if the list is filterable, overrides <see cref="FilterAsync"/> to turn the query string into a predicate.
/// </summary>
public abstract class CrudController<T>(CrudService<T> service) : ApiController where T : Entity
{
    /// <summary>The predicate for the list endpoint, or null for "everything". It may look at other resources (e.g. the vehicles of an organization type).</summary>
    protected virtual Task<Func<T, bool>?> FilterAsync(Query query, CancellationToken ct) => Task.FromResult<Func<T, bool>?>(null);

    [HttpGet]
    public async Task<ActionResult<Page<T>>> List([FromQuery] Query query, [FromQuery] PageQuery page, CancellationToken ct) =>
        Ok(await service.PageAsync(page, await FilterAsync(query, ct), ct));

    [HttpPost]
    public async Task<ActionResult<T>> Create([FromBody] T body, CancellationToken ct)
    {
        var created = await service.CreateAsync(body, ct);
        return Created($"{Request.Path.Value!.TrimEnd('/')}/{created.Id}", created);
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<T>> Get(string id, CancellationToken ct) => Ok(await service.GetAsync(id, ct));

    [HttpPatch("{id}")]
    public async Task<ActionResult<T>> Patch(string id, [FromBody] JsonElement patch, CancellationToken ct) => Ok(await service.PatchAsync(id, patch, ct));
}
