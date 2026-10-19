using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Core.Common;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Repositories;

namespace FireTrace.Core.Services.Crud;

/// <summary>Criar, ler, listar, alterar e apagar: escrito uma vez e usado por todos os recursos simples.</summary>
public class CrudService<T>(IDocumentStore<T> store, IEntityPolicy<T> policy, TimeProvider clock, IIdGenerator ids) where T : Entity
{
    public async Task<T> CreateAsync(T input, CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        var item = input with { Id = ids.New(policy.IdPrefix), CreatedAt = now, UpdatedAt = now };
        await EnsureValidAsync(item, ct);
        await store.UpsertAsync(item, ct);
        return item;
    }

    public async Task<T> GetAsync(string id, CancellationToken ct = default) =>
        await store.GetAsync(id, ct) ?? throw new NotFoundException($"{typeof(T).Name} '{id}'");

    public async Task<IReadOnlyList<T>> ListAsync(Func<T, bool>? filter = null, CancellationToken ct = default) =>
        (await store.ListAsync(ct)).Where(filter ?? (_ => true)).ToList();

    public async Task<Page<T>> PageAsync(PageQuery page, Func<T, bool>? filter = null, CancellationToken ct = default) =>
        page.Apply(await ListAsync(filter, ct), i => i.UpdatedAt);

    /// <summary>Alteração parcial (JSON Merge Patch, RFC 7396): `null` apaga o campo, objetos fundem-se, o resto substitui.</summary>
    public async Task<T> PatchAsync(string id, JsonElement patch, CancellationToken ct = default)
    {
        var current = await GetAsync(id, ct);
        var merged = MergePatch.Apply(current, patch) with { Id = current.Id, CreatedAt = current.CreatedAt, UpdatedAt = clock.GetUtcNow() };
        await EnsureValidAsync(merged, ct);
        await store.UpsertAsync(merged, ct);
        return merged;
    }

    /// <summary>Substitui o recurso por uma versão já calculada (usado por serviços que alteram estados).</summary>
    public async Task<T> SaveAsync(T item, CancellationToken ct = default)
    {
        var saved = item with { UpdatedAt = clock.GetUtcNow() };
        await store.UpsertAsync(saved, ct);
        return saved;
    }

    public async Task DeleteAsync(string id, CancellationToken ct = default)
    {
        policy.EnsureDeletable(await GetAsync(id, ct));
        await store.DeleteAsync(id, ct);
    }

    async Task EnsureValidAsync(T item, CancellationToken ct)
    {
        var issues = (await policy.ValidateAsync(item, ct)).ToList();
        if (issues.Any(i => i.Severity == "error")) throw new ValidationException(issues);
    }
}
