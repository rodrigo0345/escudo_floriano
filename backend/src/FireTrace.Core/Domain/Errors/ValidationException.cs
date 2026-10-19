using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Errors;

public sealed class ValidationException(IReadOnlyList<ValidationIssue> issues)
    : ApiException(issues.Count == 0 ? "Pedido inválido." : string.Join("; ", issues.Select(i => i.Message)), "validation_failed", 422)
{
    public ValidationException(string message, string? pointer = null) : this(new[] { new ValidationIssue("error", "validation_failed", message, pointer) }) { }
    public IReadOnlyList<ValidationIssue> Issues { get; } = issues;
}
