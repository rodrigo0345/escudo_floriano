using System.Collections.Concurrent;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Fire;

/// <summary>
/// A série de fumo num ponto. `SafeAgainAtMin`: o primeiro minuto a partir do qual o ponto fica seguro até ao fim do período consultado (nulo se já era
/// seguro durante todo o período ou se nunca volta a ser).
/// </summary>
public sealed record SmokeSeries(string? Id, LatLon? Position, string? RoadId, double MinVisibilityM, bool SafeAtStart, int? UnsafeFromMin, int? SafeAgainAtMin, IReadOnlyList<SmokeSample> Samples);
