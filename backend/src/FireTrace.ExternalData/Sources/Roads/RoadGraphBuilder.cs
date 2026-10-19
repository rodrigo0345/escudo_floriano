using System.Text.Json;
using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Roads;

/// <summary>Estradas e caminhos florestais do OSM como grafo: troços entre cruzamentos, com as células que atravessam.</summary>
public static class RoadGraphBuilder
{
    /// <summary>Corta cada via nos cruzamentos (nós partilhados) e na borda do local.</summary>
    public static (List<RoadEdge> Edges, List<RoadNode> Nodes) Build(IEnumerable<JsonElement> ways, GridSpec spec)
    {
        var runs = RoadWayClipper.Clip(ways, spec);
        var usage = new Dictionary<long, int>();
        foreach (var run in runs) foreach (var v in run.Points) usage[v.Id] = usage.GetValueOrDefault(v.Id) + 1;

        var edges = new List<RoadEdge>();
        var nodes = new Dictionary<string, RoadNode>();
        foreach (var (way, pts) in runs)
        {
            var cur = new List<WayVertex> { pts[0] };
            for (int i = 1; i < pts.Count; i++)
            {
                cur.Add(pts[i]);
                if (usage[pts[i].Id] < 2 && i != pts.Count - 1) continue;
                var flat = cur.SelectMany(p => new[] { Math.Round(p.X, 2), Math.Round(p.Y, 2) }).ToArray();
                double len = RoadGeometry.Length(flat);
                if (cur[0].Id != cur[^1].Id && len > 0.3)
                {
                    edges.Add(RoadEdgeFactory.Create(edges.Count, way, cur[0].Id.ToString(), cur[^1].Id.ToString(), flat, len, spec));
                    foreach (var n in new[] { cur[0], cur[^1] }) nodes.TryAdd(n.Id.ToString(), new RoadNode(n.Id.ToString(), Math.Round(n.X, 2), Math.Round(n.Y, 2)));
                }
                cur = new() { pts[i] };
            }
        }
        return (edges, nodes.Values.ToList());
    }
}
