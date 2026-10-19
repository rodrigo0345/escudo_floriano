using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record AerialStatus(int? Drops = null, double? WaterDeliveredL = null, double? CycleMinutes = null, string? BlockedBy = null);
