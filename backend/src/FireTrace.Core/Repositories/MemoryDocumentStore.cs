using System.Collections.Concurrent;
using System.Text.Json;
using Dapper;
using FireTrace.Core.Domain.Common;
using Npgsql;

namespace FireTrace.Core.Repositories;

/// <summary>Os mesmos documentos em memória: para testes e para correr sem base de dados.</summary>
public sealed class MemoryDocumentStore<T> : IDocumentStore<T> where T : Entity
{
    readonly ConcurrentDictionary<string, T> _items = new();

    public Task<T?> GetAsync(string id, CancellationToken ct = default) => Task.FromResult(_items.GetValueOrDefault(id));
    public Task<IReadOnlyList<T>> ListAsync(CancellationToken ct = default) => Task.FromResult<IReadOnlyList<T>>(_items.Values.OrderBy(i => i.CreatedAt).ThenBy(i => i.Id).ToList());
    public Task UpsertAsync(T item, CancellationToken ct = default) { _items[item.Id] = item; return Task.CompletedTask; }
    public Task<bool> DeleteAsync(string id, CancellationToken ct = default) => Task.FromResult(_items.TryRemove(id, out _));
}
