using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Scenarios;

public sealed record InitialFire(Geometry Perimeter, DateTimeOffset? AsOf = null, string? Source = null);
