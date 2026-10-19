namespace FireTrace.ExternalData.Ingest;

/// <summary>Onde o ingest e as fontes de dados contam o que estão a fazer. O CLI escreve na consola; noutros sítios não se escreve nada.</summary>
public interface IIngestLog
{
    void Info(string message);

    /// <summary>Algo falhou mas o ingest continua (uma tentativa repetida, uma camada opcional que não veio).</summary>
    void Warn(string message);
}
