using FireTrace.ExternalData.Configuration;

namespace FireTrace.ExternalData.Ingest;

/// <summary>
/// A cidade 3D (tiles fotorrealistas guardados uma vez em `data/tiles3d/&lt;local&gt;/`): este passo não obtém nada (a descarga é de `tools/fetch_tiles3d.py`, que pede a chave e gasta pedidos
/// pagos), só avisa se faltam num local que os usa. Sem eles o mapa 3D funciona na mesma, apenas sem a camada da cidade.
/// </summary>
public sealed class Tiles3dStep(ExternalDataPaths paths, IIngestLog log) : IIngestStep
{
    public string Name => "tiles3d";
    public int Order => 90;

    public Task RunAsync(IngestContext ctx)
    {
        if (!ctx.Location.Tiles3d) { log.Info("  desligado neste local"); return Task.CompletedTask; }
        var folder = Path.Combine(paths.DataDir, "tiles3d", ctx.Id);
        if (File.Exists(Path.Combine(folder, "manifest.json"))) log.Info($"  cidade 3D encontrada em {folder}");
        else log.Warn($"  FALTAM os tiles da cidade 3D em {folder} (cópia local, opcional): o mapa funciona sem eles e a cidade 3D pode ser ligada ao vivo na interface (pede a chave). Para guardar uma cópia: python tools/fetch_tiles3d.py --location {ctx.Id}.");
        return Task.CompletedTask;
    }
}
