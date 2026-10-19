using System.Text.Json;
using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Roads;

public static class RoadWayClipper
{
    /// <summary>Corta cada via na borda do local: devolve os troços que ficam dentro, cada um com o primeiro nó de fora encostado à borda.</summary>
    public static List<WayRun> Clip(IEnumerable<JsonElement> ways, GridSpec spec)
    {
        var runs = new List<WayRun>();
        foreach (var el in ways)
        {
            var ids = el.GetProperty("nodes").EnumerateArray().Select(n => n.GetInt64()).ToArray();
            var geo = el.GetProperty("geometry").EnumerateArray().ToArray();
            var verts = ids.Select((id, i) => { var (x, y) = spec.ToCell(geo[i].GetProperty("lat").GetDouble(), geo[i].GetProperty("lon").GetDouble()); return new WayVertex(id, x, y); }).ToArray();
            WayVertex Clamp(WayVertex v) => v with { X = Math.Clamp(v.X, 0, spec.Width - 1), Y = Math.Clamp(v.Y, 0, spec.Height - 1) };
            var run = new List<WayVertex>();
            for (int i = 0; i < verts.Length; i++)
            {
                if (spec.Inside(verts[i].X, verts[i].Y))
                {
                    if (run.Count == 0 && i > 0) run.Add(Clamp(verts[i - 1]));
                    run.Add(verts[i]);
                }
                else if (run.Count > 0) { run.Add(Clamp(verts[i])); runs.Add(new WayRun(el, run)); run = new(); }
            }
            if (run.Count > 1) runs.Add(new WayRun(el, run));
        }
        return runs;
    }
}
