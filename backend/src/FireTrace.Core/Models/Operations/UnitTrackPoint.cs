using FireTrace.Core.Domain.Dispatches;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Operations;

/// <summary>Onde um meio está, em que estado, com quanta água e quão cansado, a um minuto da simulação.</summary>
public sealed record UnitTrackPoint(int TMin, DispatchStatus Status, LatLon? Position = null, double? WaterLevelL = null, double? FatiguePct = null);
