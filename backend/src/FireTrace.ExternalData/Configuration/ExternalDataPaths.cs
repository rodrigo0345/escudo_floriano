namespace FireTrace.ExternalData.Configuration;

/// <summary>Onde estão os ficheiros e a base de dados; igual para o ingest e para a API. Obtém-se com <see cref="ExternalDataPathsResolver"/>.</summary>
public sealed record ExternalDataPaths(string ConnectionString, string LocationsDir, string DataDir);
