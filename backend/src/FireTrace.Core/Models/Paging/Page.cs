using System.Text.Json.Nodes;
using System.Text.Json;

namespace FireTrace.Core.Models.Paging;

/// <summary>Uma página de resultados com cursor (`nextCursor` vazio = não há mais).</summary>
public sealed record Page<T>(IReadOnlyList<T> Items, [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] string? NextCursor, int? Total = null);
