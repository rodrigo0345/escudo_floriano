using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

/// <summary>
/// Quando o fogo corta cada troço: desde que há chamas na via ou numa célula vizinha até acabarem de arder. Calcula-se por membro do ensemble
/// e dá em O(células das vias), em vez de uma máscara por minuto.
/// </summary>
public sealed class RoadCuts
{
    public int[] From { get; }
    public int[] Until { get; }

    RoadCuts(int[] from, int[] until) { From = from; Until = until; }

    public static RoadCuts Compute(RoadNetwork net, int[] ignition, int[] burnMinutes)
    {
        int w = net.Spec.Width, h = net.Spec.Height;
        var from = new int[net.Edges.Count]; var until = new int[net.Edges.Count];
        for (int k = 0; k < from.Length; k++)
        {
            int first = int.MaxValue, last = -1;
            foreach (int cell in net.Edges[k].CellIdx)
            {
                int cx = cell % w, cy = cell / w;
                for (int dy = -1; dy <= 1; dy++)
                    for (int dx = -1; dx <= 1; dx++)
                    {
                        int nx = cx + dx, ny = cy + dy;
                        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        int n = ny * w + nx, i = ignition[n];
                        if (i < 0) continue;
                        first = Math.Min(first, i); last = Math.Max(last, i + burnMinutes[n]);
                    }
            }
            from[k] = last < 0 ? -1 : first; until[k] = last;
        }
        return new RoadCuts(from, until);
    }

    public bool IsCut(int edge, int minute) => From[edge] >= 0 && minute >= From[edge] && minute < Until[edge];

    /// <summary>O troço está cortado em algum momento entre `from` e `to` (minutos)?</summary>
    public bool IsCutDuring(int edge, double from, double to) => From[edge] >= 0 && from < Until[edge] && to > From[edge];
}
