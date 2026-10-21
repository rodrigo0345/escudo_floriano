using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Operations;

/// <summary>Um acontecimento na vida de um meio (`departed`, `arrived`, `started_working`, `water_empty`, `refill_started`, `refill_done`, `rest_started`, `rest_done`, `returned`...).</summary>
public sealed record UnitEvent(int TMin, string Type, LatLon? Position = null, string? Detail = null);
