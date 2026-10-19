using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record Contact(string Role, string? Name = null, string? Phone = null, string? Email = null, string? RadioChannel = null, bool? Available24h = null);
