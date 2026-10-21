using FireTrace.Core.Domain.Dispatches;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Operations;

/// <summary>Uma amostra do trajeto de um meio.</summary>
public sealed record UnitTrackPoint(int TMin, LatLon? Position, DispatchStatus Status, double? WaterLevelL = null, double? FatiguePct = null);
