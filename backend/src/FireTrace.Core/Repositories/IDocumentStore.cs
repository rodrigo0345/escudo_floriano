using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Core.Domain.Common;

namespace FireTrace.Core.Repositories;

/// <summary>Onde se guardam os recursos de um tipo. Quem usa não sabe se é PostgreSQL ou memória.</summary>
public interface IDocumentStore<T> where T : Entity
{
    Task<T?> GetAsync(string id, CancellationToken ct = default);
    Task<IReadOnlyList<T>> ListAsync(CancellationToken ct = default);
    Task UpsertAsync(T item, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}
