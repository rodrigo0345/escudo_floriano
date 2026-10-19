using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record Jurisdiction(string? Level = null, string? Name = null, List<string>? LocationIds = null, Geometry? Area = null);
