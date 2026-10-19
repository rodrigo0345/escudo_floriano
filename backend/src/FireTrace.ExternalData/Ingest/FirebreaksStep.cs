using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>
/// Aceiros e faixas de gestão de combustível. O OSM quase não os tem, por isso vêm de um ficheiro GeoJSON opcional
/// (`data/sources/firebreaks.geojson`, por exemplo da rede primária do ICNF) com `kind`, `name`, `widthM`, `maintained` e `source` nas propriedades.
/// </summary>
public sealed class FirebreaksStep(ExternalDataPaths paths, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "firebreaks";
    public int Order => 90;

    public async Task RunAsync(IngestContext ctx)
    {
        var file = Path.Combine(paths.DataDir, "sources", "firebreaks.geojson");
        if (!File.Exists(file)) { log.Info($"  sem {file}: nenhuma camada de aceiros carregada"); return; }
        using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(file));
        var items = FirebreakGeoJsonParser.Parse(doc.RootElement, ctx.Spec.Bounds);
        log.Info($"  {items.Count} aceiros e faixas dentro do local");
        await writer.ReplaceFirebreaksAsync(ctx.Id, items);
    }
}
