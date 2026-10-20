using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Errors;

namespace FireTrace.Core.Services.Crud;

public abstract class EntityPolicy<T>(string prefix) : IEntityPolicy<T> where T : Entity
{
    public string IdPrefix { get; } = prefix;
    public virtual T Prepare(T item) => item;
    public virtual Task<IEnumerable<ValidationIssue>> ValidateAsync(T item, CancellationToken ct) => Task.FromResult(Enumerable.Empty<ValidationIssue>());
    public virtual void EnsureDeletable(T item) { }
}
