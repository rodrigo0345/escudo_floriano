using System.Globalization;
using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Ingest;

/// <summary>
/// Aceiros e faixas de gestão de combustível. Descarregados do OpenStreetMap (cutlines, barreiras corta-fogo e caminhos de acesso florestal)
/// e complementados por ficheiro GeoJSON opcional (`data/sources/firebreaks.geojson`, por exemplo da rede primária do ICNF).
/// </summary>
public sealed class FirebreaksStep(OverpassClient overpass, OverpassOptions overpassOptions, ExternalDataPaths paths, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "firebreaks";
    public int Order => 90;

    public async Task RunAsync(IngestContext ctx)
    {
        var items = new List<Firebreak>();
        var seenIds = new HashSet<long>();
        var b = ctx.Spec.Bounds;
        var area = Wgs84.Factory.ToGeometry(new Envelope(b.West, b.East, b.South, b.North));

        // 1. Descarrega aceiros e corta-fogos do OpenStreetMap
        try
        {
            await overpass.ForEachBlockAsync(ctx.Spec, overpassOptions.Blocks.RoadsM, async box =>
            {
                var bbox = OverpassBbox.Of(box);
                var query = $"{overpass.Prefix()}(way[\"man_made\"=\"cutline\"]{bbox};way[\"barrier\"=\"firebreak\"]{bbox};way[\"firebreak\"]{bbox};way[\"highway\"=\"track\"][\"tracktype\"~\"grade[45]\"]{bbox};);out geom tags;";
                using var doc = await overpass.QueryAsync(query);
                foreach (var el in OsmJson.Elements(doc))
                {
                    long id = el.GetProperty("id").GetInt64();
                    if (!seenIds.Add(id) || !el.TryGetProperty("geometry", out var g) || g.GetArrayLength() < 2) continue;

                    var coords = g.EnumerateArray()
                        .Select(p => new Coordinate(p.GetProperty("lon").GetDouble(), p.GetProperty("lat").GetDouble()))
                        .ToArray();
                    var line = Wgs84.Factory.CreateLineString(coords);
                    var inside = line.Intersection(area);
                    if (inside.IsEmpty) continue;

                    var mm = OsmJson.Tag(el, "man_made");
                    var barrier = OsmJson.Tag(el, "barrier");
                    var fb = OsmJson.Tag(el, "firebreak");
                    var tracktype = OsmJson.Tag(el, "tracktype");

                    FirebreakKind kind = (mm == "cutline" || barrier == "firebreak" || fb is "yes")
                        ? FirebreakKind.Firebreak
                        : FirebreakKind.FuelManagementStrip;

                    string? name = OsmJson.Tag(el, "name") ?? OsmJson.Tag(el, "ref");
                    if (string.IsNullOrWhiteSpace(name))
                        name = kind == FirebreakKind.Firebreak ? "Aceiro florestal" : $"Faixa corta-fogo ({tracktype ?? "caminho"})";

                    double? width = double.TryParse(OsmJson.Tag(el, "width"), NumberStyles.Float, CultureInfo.InvariantCulture, out var w)
                        ? w
                        : (kind == FirebreakKind.Firebreak ? 15.0 : 6.0);

                    items.Add(new Firebreak(0, kind, name, width, true, "osm", inside));
                }
                return $"{items.Count} aceiros e faixas";
            });
        }
        catch (Exception ex)
        {
            log.Warn($"  aviso ao obter aceiros do OSM: {ex.Message}");
        }

        // 2. Ficheiro GeoJSON adicional se existir
        var file = Path.Combine(paths.DataDir, "sources", "firebreaks.geojson");
        if (File.Exists(file))
        {
            try
            {
                using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(file));
                var fileItems = FirebreakGeoJsonParser.Parse(doc.RootElement, ctx.Spec.Bounds);
                log.Info($"  {fileItems.Count} aceiros adicionais de {file}");
                items.AddRange(fileItems);
            }
            catch (Exception ex)
            {
                log.Warn($"  aviso ao carregar {file}: {ex.Message}");
            }
        }

        log.Info($"  total {items.Count} aceiros e faixas guardados");
        await writer.ReplaceFirebreaksAsync(ctx.Id, items);
    }
}
