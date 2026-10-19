using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Simulations;

public sealed record ProblemInfo(string Title, int Status, string? Detail = null, string? Code = null);
