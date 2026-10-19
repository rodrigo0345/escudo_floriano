using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

/// <summary>Meio aéreo: o que define o ciclo ida–carga–largada e quando fica em terra.</summary>
public sealed record AerialSpec(double? BucketCapacityL = null, double? LoadMinutes = null, double? DropMinutes = null, double? CruiseSpeedKmh = null,
    double? MaxWindKmh = null, double? MinVisibilityM = null, bool DayOnly = true);
