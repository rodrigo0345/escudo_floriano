namespace FireTrace.ExternalData.Map;

/// <summary>
/// As classes de vegetação que o mapa guarda na grelha "landcover" (um byte por célula). Os ids são estáveis porque estão gravados na base de dados;
/// o que cada classe significa para o fogo (combustível, copado, cores) vive em `appsettings.json` da API, em FireTrace:Fuels.
/// </summary>
public static class LandCover
{
    public const byte NoData = 0, Agricola = 1, Pasto = 2, Rocha = 3, Mato = 4, FlorestaMista = 5, Urbano = 6, Agua = 7, Eucalipto = 8, Pinheiro = 9, Folhosas = 10;
    public const int Count = 11;

    static readonly string[] Keys = { "sem_dados", "agricola", "pasto", "rocha", "mato", "floresta", "urbano", "agua", "eucalipto", "pinheiro", "folhosas" };

    public static string KeyOf(int id) => id >= 0 && id < Keys.Length ? Keys[id] : Keys[0];

    public static byte IdOf(string key) => Array.IndexOf(Keys, key) is var i and >= 0 ? (byte)i : throw new InvalidOperationException($"Classe de vegetação desconhecida: '{key}'.");
}
