using System.Collections.Concurrent;
using System.Runtime.CompilerServices;

namespace FireTrace.Core.Services.Routing;

/// <summary>Um percurso: troços, distância, tempo e geometria em coordenadas de célula (x,y alternados).</summary>
public sealed record PathResult(IReadOnlyList<int> EdgeIds, double DistanceM, double Minutes, double[] Points);
