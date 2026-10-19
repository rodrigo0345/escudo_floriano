using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Ingest;

public static class FirebreakGeoJsonParser
{
    /// <summary>Os aceiros de um GeoJSON (`kind`, `name`, `widthM`, `maintained` e `source` nas propriedades) que tocam a área do local.</summary>
    public static List<Firebreak> Parse(JsonElement root, GeoBounds area)
    {
        var items = new List<Firebreak>();
        foreach (var f in root.GetProperty("features").EnumerateArray())
        {
            var p = f.GetProperty("properties");
            var geometry = GeoJson.Parse(f.GetProperty("geometry"));
            if (!geometry.EnvelopeInternal.Intersects(new Envelope(area.West, area.East, area.South, area.North))) continue;
            items.Add(new Firebreak(0, p.TryGetProperty("kind", out var k) && EnumText.TryParse<FirebreakKind>(k.GetString(), out var kind) ? kind : FirebreakKind.Firebreak,
                p.TryGetProperty("name", out var n) ? n.GetString() : null, p.TryGetProperty("widthM", out var w) && w.ValueKind == JsonValueKind.Number ? w.GetDouble() : null,
                !p.TryGetProperty("maintained", out var m) || m.ValueKind != JsonValueKind.False, p.TryGetProperty("source", out var s) ? s.GetString() ?? "file" : "file", geometry));
        }
        return items;
    }
}
