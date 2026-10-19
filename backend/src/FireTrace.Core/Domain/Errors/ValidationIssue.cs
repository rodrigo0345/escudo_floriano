using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Errors;

public sealed record ValidationIssue(string Severity, string Code, string Message, string? Pointer = null, string? ActionId = null, string? ResourceId = null);
