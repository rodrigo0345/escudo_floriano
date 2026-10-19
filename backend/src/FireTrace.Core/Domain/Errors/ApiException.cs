using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Errors;

/// <summary>Erros que a camada Web traduz para respostas `application/problem+json`.</summary>
public abstract class ApiException(string message, string code, int status) : Exception(message)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}
