using System.Globalization;
using System.Text.Json;

namespace FireTrace.ExternalData.Sources.Vegetation;

public static class StacSceneParser
{
    /// <summary>Das cenas devolvidas pela pesquisa STAC, a de menor nebulosidade de cada tile Sentinel-2.</summary>
    public static List<Sentinel2SceneInfo> Parse(JsonElement searchResult)
    {
        var best = new Dictionary<string, (double Cloud, JsonElement F)>();
        foreach (var f in searchResult.GetProperty("features").EnumerateArray())
        {
            var p = f.GetProperty("properties");
            string tile = p.TryGetProperty("grid:code", out var gc) ? gc.GetString()! : f.GetProperty("id").GetString()![..12];
            double cc = p.GetProperty("eo:cloud_cover").GetDouble();
            if (!best.TryGetValue(tile, out var b) || cc < b.Cloud) best[tile] = (cc, f);
        }
        var list = new List<Sentinel2SceneInfo>();
        foreach (var (tile, (_, f)) in best)
        {
            var p = f.GetProperty("properties"); var a = f.GetProperty("assets");
            var tr = (p.TryGetProperty("proj:transform", out var t1) ? t1 : a.GetProperty("red").GetProperty("proj:transform")).EnumerateArray().Select(v => v.GetDouble()).ToArray();
            var shape = (p.TryGetProperty("proj:shape", out var s1) ? s1 : a.GetProperty("red").GetProperty("proj:shape")).EnumerateArray().Select(v => v.GetInt32()).ToArray();
            string code = p.TryGetProperty("proj:code", out var pc) ? pc.GetString()! : "EPSG:" + p.GetProperty("proj:epsg").GetInt32();
            int zone = int.Parse(code[^2..], CultureInfo.InvariantCulture); // EPSG:326zz
            list.Add(new Sentinel2SceneInfo(f.GetProperty("id").GetString()!, tile, tr[2], tr[5], tr[0], zone, shape[1], shape[0],
                a.GetProperty("red").GetProperty("href").GetString()!, a.GetProperty("nir").GetProperty("href").GetString()!));
        }
        return list;
    }
}
