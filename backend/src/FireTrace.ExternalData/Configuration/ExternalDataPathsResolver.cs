namespace FireTrace.ExternalData.Configuration;

/// <summary>
/// O único código que lê o ambiente (variáveis de ambiente, pasta atual, pasta do binário) para descobrir onde estão a base de dados, os locais e os dados
/// (variáveis de ambiente, com valores por omissão para desenvolvimento).
/// </summary>
public sealed class ExternalDataPathsResolver
{
    /// <summary>A ligação vem de `FIRETRACE_DB` ou, por omissão, de <paramref name="defaultConnectionString"/> (FireTrace:ExternalData:ConnectionString em `externaldata.settings.json`).</summary>
    public ExternalDataPaths Resolve(string defaultConnectionString, string locationsDirOverride = "", string dataDirOverride = "") => new(
        Environment.GetEnvironmentVariable("FIRETRACE_DB") ?? defaultConnectionString,
        ResolveFolder("locations", locationsDirOverride, "FIRETRACE_LOCATIONS"),
        ResolveFolder("data", dataDirOverride, "FIRETRACE_DATA"));

    /// <summary>Procura a pasta no valor pedido, na variável de ambiente ou subindo a partir da pasta atual e do binário (útil em `dotnet run` e em Docker). `mustContain` evita confundir a pasta com outra de nome igual (`Web` do código vs. `web` do cliente).</summary>
    public string ResolveFolder(string folder, string explicitPath, string envVar, string? mustContain = null)
    {
        if (explicitPath != "") return Path.GetFullPath(explicitPath);
        if (Environment.GetEnvironmentVariable(envVar) is { Length: > 0 } fromEnv) return Path.GetFullPath(fromEnv);
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
            for (var d = new DirectoryInfo(start); d is not null; d = d.Parent)
                if (Directory.Exists(Path.Combine(d.FullName, folder)) && (mustContain is null || File.Exists(Path.Combine(d.FullName, folder, mustContain)))) return Path.Combine(d.FullName, folder);
        return Path.GetFullPath(folder);
    }
}
