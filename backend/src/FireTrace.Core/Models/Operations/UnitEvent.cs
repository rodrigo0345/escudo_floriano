using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Operations;

/// <summary>Um acontecimento na vida de um meio: partiu, chegou, ficou sem água, descansou, voltou.</summary>
public sealed record UnitEvent(int TMin, string Type, LatLon? Position = null, string? Detail = null);
