using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Errors;

namespace FireTrace.Core.Services.Crud;

/// <summary>Regras específicas de um tipo de recurso (referências a outros recursos, limites). Por omissão não há nenhuma.</summary>
public interface IEntityPolicy<T> where T : Entity
{
    string IdPrefix { get; }
    /// <summary>Preenche o que se deduz do próprio recurso antes de o validar e guardar (por omissão nada).</summary>
    T Prepare(T item);
    Task<IEnumerable<ValidationIssue>> ValidateAsync(T item, CancellationToken ct);
    /// <summary>Lança um <see cref="ConflictException"/> se o recurso não puder ser apagado.</summary>
    void EnsureDeletable(T item);
}
