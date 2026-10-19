using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Ingest;

/// <summary>O local que cada passo do ingest está a carregar; o resto (onde escrever, a pasta de dados…) cada passo recebe por construtor.</summary>
public sealed record IngestContext(LocationDefinition Location)
{
    public GridSpec Spec => Location.Spec;
    public string Id => Location.Id;
}
