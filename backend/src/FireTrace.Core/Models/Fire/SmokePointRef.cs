using System.Collections.Concurrent;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Fire;

/// <summary>Um ponto a consultar: uma posição ou um troço de estrada (a pior visibilidade ao longo dele).</summary>
public sealed record SmokePointRef(string? Id, LatLon? Position, string? RoadId = null);
