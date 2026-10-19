namespace FireTrace.ExternalData.Ingest;

/// <summary>
/// Um passo do carregamento de um local (relevo, vegetação, estradas…). Para acrescentar dados ao mapa basta criar uma classe que implemente isto
/// e registá-la em <see cref="ServiceCollectionExtensions.AddExternalData"/>: o <see cref="IngestRunner"/> executa-a pela ordem de <see cref="Order"/>.
/// </summary>
public interface IIngestStep
{
    /// <summary>Nome usado em `--only` e `--skip`.</summary>
    string Name { get; }
    int Order { get; }
    Task RunAsync(IngestContext ctx);
}
