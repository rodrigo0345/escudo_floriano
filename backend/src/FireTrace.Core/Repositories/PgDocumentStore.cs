using System.Collections.Concurrent;
using System.Text.Json;
using Dapper;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Serialization;
using Npgsql;

namespace FireTrace.Core.Repositories;

/// <summary>Documentos JSON em PostgreSQL: uma tabela para todos os tipos (a coleção é o nome do tipo). Os filtros fazem-se em memória, sobre centenas de itens.</summary>
public sealed class PgDocumentStore<T>(NpgsqlDataSource db) : IDocumentStore<T> where T : Entity
{
    static readonly string Collection = typeof(T).Name.ToLowerInvariant();

    public async Task<T?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var c = await db.OpenConnectionAsync(ct);
        var body = await c.QuerySingleOrDefaultAsync<string>("SELECT body::text FROM documents WHERE collection=@Collection AND id=@id", new { Collection, id });
        return body is null ? null : JsonSerializer.Deserialize<T>(body, ApiJson.Options);
    }

    public async Task<IReadOnlyList<T>> ListAsync(CancellationToken ct = default)
    {
        await using var c = await db.OpenConnectionAsync(ct);
        var rows = await c.QueryAsync<string>("SELECT body::text FROM documents WHERE collection=@Collection ORDER BY created_at, id", new { Collection });
        return rows.Select(b => JsonSerializer.Deserialize<T>(b, ApiJson.Options)!).ToList();
    }

    public async Task UpsertAsync(T item, CancellationToken ct = default)
    {
        await using var c = await db.OpenConnectionAsync(ct);
        await c.ExecuteAsync(@"INSERT INTO documents(collection,id,body,created_at,updated_at) VALUES (@Collection,@Id,@body::jsonb,@CreatedAt,@UpdatedAt)
            ON CONFLICT (collection,id) DO UPDATE SET body=@body::jsonb, updated_at=@UpdatedAt",
            new { Collection, item.Id, body = JsonSerializer.Serialize(item, ApiJson.Options), item.CreatedAt, item.UpdatedAt });
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var c = await db.OpenConnectionAsync(ct);
        return await c.ExecuteAsync("DELETE FROM documents WHERE collection=@Collection AND id=@id", new { Collection, id }) > 0;
    }
}
