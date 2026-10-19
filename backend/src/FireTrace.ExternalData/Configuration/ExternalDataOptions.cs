using Microsoft.Extensions.Configuration;

namespace FireTrace.ExternalData.Configuration;

// Os valores do carregamento do mapa vivem em `externaldata.settings.json` (secção FireTrace:ExternalData), nunca no código. Não há valores por omissão
// aqui: se faltar uma chave, falha-se ao arrancar em vez de simular com um número escondido.

public sealed record ExternalDataOptions(string ConnectionString, int CacheTtlMinutes, OpenMeteoOptions OpenMeteo, HttpOptions Http, OverpassOptions Overpass, RoadOptions Roads, PlaceOptions Places,
    WaterOptions Water, WaterwayOptions Waterways, TerrainOptions Terrain, ImageryOptions Imagery, OrthoOptions Ortho, LandCoverOptions LandCover)
{
    public const string FileName = "externaldata.settings.json";
    public const string SectionName = "FireTrace:ExternalData";

    public static ExternalDataOptions FromConfiguration(IConfiguration configuration) =>
        configuration.GetSection(SectionName).Get<ExternalDataOptions>() ?? throw new InvalidOperationException($"Falta a secção {SectionName} em {FileName}.");

    /// <summary>As opções de um ficheiro JSON, sem mais nenhuma fonte (variáveis de ambiente incluídas): é só função do ficheiro.</summary>
    public static ExternalDataOptions FromFile(string path) =>
        FromConfiguration(new ConfigurationBuilder().AddJsonFile(path, optional: false).Build());
}
