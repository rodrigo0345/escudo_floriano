using FireTrace.Core.Domain.Common;
using FireTrace.Core.Services.Crud;

namespace FireTrace.Core.Controllers;

/// <summary>A <see cref="CrudController{T}"/> whose resources can also be deleted. Resources that must stay (e.g. road closures) derive from the plain one.</summary>
public abstract class DeletableCrudController<T>(CrudService<T> service) : CrudController<T>(service) where T : Entity
{
    readonly CrudService<T> _service = service;

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        await _service.DeleteAsync(id, ct);
        return NoContent();
    }
}
