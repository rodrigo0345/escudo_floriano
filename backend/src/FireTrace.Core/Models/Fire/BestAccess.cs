using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record BestAccess(string? FromStationId, string? OrganizationType, double? Minutes, bool Reachable);
