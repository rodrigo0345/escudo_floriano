using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Common;

/// <summary>Tudo o que se guarda e se lista tem id e datas. É a base de todos os recursos (viaturas, planos, cenários…).</summary>
public abstract record Entity
{
    public string Id { get; init; } = "";
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
    public List<string>? Tags { get; init; }
    /// <summary>Espaço de extensão livre, guardado e devolvido sem interpretação.</summary>
    public Dictionary<string, JsonElement>? Metadata { get; init; }
}
