using FireTrace.Core.Domain.Dispatches;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Operations;

/// <summary>Uma amostra do trajeto de um meio.</summary>
public sealed record UnitTrackPoint(int TMin, DispatchStatus Status, LatLon? Position = null, double? WaterLevelL = null, double? FatiguePct = null, double? FuelPct = null);
