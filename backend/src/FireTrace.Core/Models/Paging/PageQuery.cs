using System.Text.Json.Nodes;
using System.Text.Json;

namespace FireTrace.Core.Models.Paging;

/// <summary>Os parâmetros de paginação comuns a todas as listas: `limit`, `cursor` e `updatedAfter` (para acompanhar mudanças sem eventos).</summary>
public sealed record PageQuery(int Limit, string? Cursor = null, DateTimeOffset? UpdatedAfter = null)
{
    public Page<T> Apply<T>(IEnumerable<T> items, Func<T, DateTimeOffset>? updatedAt = null)
    {
        var all = (UpdatedAfter is { } after && updatedAt is not null ? items.Where(i => updatedAt(i) > after) : items).ToList();
        int skip = Cursor is null ? 0 : int.TryParse(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(Cursor)), out var s) ? s : 0;
        int limit = Math.Max(1, Limit); // o máximo aplica-se à entrada (Query.Page)
        var page = all.Skip(skip).Take(limit).ToList();
        string? next = skip + limit < all.Count ? Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes((skip + limit).ToString())) : null;
        return new Page<T>(page, next, all.Count);
    }
}
