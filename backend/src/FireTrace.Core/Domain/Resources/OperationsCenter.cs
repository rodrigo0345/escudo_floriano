using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record OperationsCenter(string? Name = null, string? Phone = null, string? RadioChannel = null);
