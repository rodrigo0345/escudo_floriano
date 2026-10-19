using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

/// <summary>O grafo viário indexado para pesquisas de caminho mais curto (Dijkstra multi-origem), com troços bloqueáveis.</summary>
public sealed class RoadGraph
{
    public static RoadGraph For(RoadNetwork net) => new(net);

    public RoadNetwork Net { get; }
    readonly string[] _nodeIds;
    readonly (int To, int Edge)[][] _adj;
    readonly bool[] _main;
    readonly double[] _x, _y;
    readonly int[] _edgeA, _edgeB;
    readonly ConcurrentDictionary<(double, double), int> _snap = new();

    RoadGraph(RoadNetwork net)
    {
        Net = net;
        _nodeIds = net.Edges.SelectMany(e => new[] { e.A, e.B }).Distinct().ToArray();
        var index = _nodeIds.Select((id, i) => (id, i)).ToDictionary(t => t.id, t => t.i);
        _x = new double[_nodeIds.Length]; _y = new double[_nodeIds.Length];
        for (int i = 0; i < _nodeIds.Length; i++) if (net.Nodes.TryGetValue(_nodeIds[i], out var n)) { _x[i] = n.X; _y[i] = n.Y; }
        var adj = _nodeIds.Select(_ => new List<(int, int)>()).ToArray();
        _edgeA = new int[net.Edges.Count]; _edgeB = new int[net.Edges.Count];
        for (int k = 0; k < net.Edges.Count; k++)
        {
            int a = index[net.Edges[k].A], b = index[net.Edges[k].B];
            _edgeA[k] = a; _edgeB[k] = b;
            adj[a].Add((b, k)); adj[b].Add((a, k));
        }
        _adj = adj.Select(l => l.ToArray()).ToArray();
        _main = MainComponent(net.Spec);
    }

    /// <summary>Só a maior componente ligada e longe da borda: nós cortados na borda do local são artefactos do recorte.</summary>
    bool[] MainComponent(GridSpec spec)
    {
        var comp = Enumerable.Repeat(-1, _nodeIds.Length).ToArray(); var sizes = new List<int>();
        for (int s = 0; s < _nodeIds.Length; s++)
        {
            if (comp[s] >= 0) continue;
            int size = 0; var stack = new Stack<int>(); stack.Push(s); comp[s] = sizes.Count;
            while (stack.Count > 0) { var u = stack.Pop(); size++; foreach (var (v, _) in _adj[u]) if (comp[v] < 0) { comp[v] = sizes.Count; stack.Push(v); } }
            sizes.Add(size);
        }
        int best = sizes.Count == 0 ? -1 : sizes.IndexOf(sizes.Max());
        return Enumerable.Range(0, _nodeIds.Length).Select(i => comp[i] == best && _x[i] > 0.5 && _y[i] > 0.5 && _x[i] < spec.Width - 1.5 && _y[i] < spec.Height - 1.5).ToArray();
    }

    /// <summary>O nó da rede mais próximo (só entre os da componente principal).</summary>
    public int Snap(double x, double y) => _snap.GetOrAdd((x, y), _ =>
    {
        int best = -1; double bd = double.MaxValue;
        for (int i = 0; i < _nodeIds.Length; i++)
        {
            if (!_main[i]) continue;
            double d = (_x[i] - x) * (_x[i] - x) + (_y[i] - y) * (_y[i] - y);
            if (d < bd) { bd = d; best = i; }
        }
        return best;
    });

    sealed record Search(double[] Dist, int[] PrevNode, int[] PrevEdge);

    Search Dijkstra(IEnumerable<int> origins, Func<int, bool> blocked, double?[] minutes)
    {
        var dist = new double[_nodeIds.Length]; Array.Fill(dist, double.PositiveInfinity);
        var prevNode = new int[_nodeIds.Length]; var prevEdge = new int[_nodeIds.Length];
        Array.Fill(prevNode, -1); Array.Fill(prevEdge, -1);
        var pq = new PriorityQueue<int, double>();
        foreach (var n in origins) if (n >= 0) { dist[n] = 0; pq.Enqueue(n, 0); }
        while (pq.TryDequeue(out var u, out var d))
        {
            if (d > dist[u]) continue;
            foreach (var (v, e) in _adj[u])
            {
                if (blocked(e) || minutes[e] is not { } w) continue;
                if (d + w < dist[v]) { dist[v] = d + w; prevNode[v] = u; prevEdge[v] = e; pq.Enqueue(v, d + w); }
            }
        }
        return new Search(dist, prevNode, prevEdge);
    }

    double[]? _slopes;
    /// <summary>Declive (%) de cada troço, para as regras de movimento (sem isto, tudo é plano).</summary>
    public RoadGraph WithSlopes(double[] slopePercent) { _slopes = slopePercent; return this; }
    public double SlopeOf(int edge) => _slopes?[edge] ?? 0;

    double?[] Costs(TravelProfile profile) => Net.Edges.Select((e, i) => profile.Minutes(e, Net.Spec.CellM, SlopeOf(i))).ToArray();

    /// <summary>Minutos desde a origem mais próxima até cada alvo, sem passar por troços bloqueados (nada = sem acesso).</summary>
    public double?[] AccessTimes(IReadOnlyList<Anchor> origins, IReadOnlyList<Anchor> targets, TravelProfile profile, Func<int, bool>? blocked = null)
    {
        var s = Dijkstra(origins.Select(o => Snap(o.X, o.Y)), blocked ?? (_ => false), Costs(profile));
        return targets.Select(t => Snap(t.X, t.Y) is var n && n >= 0 && double.IsFinite(s.Dist[n]) ? (double?)Math.Round(s.Dist[n], 1) : null).ToArray();
    }

    /// <summary>O melhor percurso entre dois pontos (nada se não houver caminho).</summary>
    public PathResult? Route(Anchor from, Anchor to, TravelProfile profile, Func<int, bool>? blocked = null)
    {
        int a = Snap(from.X, from.Y), b = Snap(to.X, to.Y);
        if (a < 0 || b < 0) return null;
        var s = Dijkstra(new[] { a }, blocked ?? (_ => false), Costs(profile));
        if (!double.IsFinite(s.Dist[b])) return null;
        var edges = new List<int>(); var pts = new List<double>();
        for (int n = b; s.PrevEdge[n] >= 0; n = s.PrevNode[n])
        {
            int e = s.PrevEdge[n]; edges.Add(e);
            var seg = Net.Edges[e].Pts;
            bool forward = _edgeB[e] == n; // percorrido de A para B
            var ordered = forward ? seg : Enumerable.Range(0, seg.Length / 2).Reverse().SelectMany(i => new[] { seg[2 * i], seg[2 * i + 1] }).ToArray();
            pts.InsertRange(0, ordered);
        }
        edges.Reverse();
        double meters = edges.Sum(e => Net.Edges[e].LengthCells * Net.Spec.CellM);
        return new PathResult(edges.Select(e => Net.Edges[e].Id).ToList(), Math.Round(meters), Math.Round(s.Dist[b], 1), pts.ToArray());
    }
}
