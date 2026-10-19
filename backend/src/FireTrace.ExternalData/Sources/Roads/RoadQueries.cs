using FireTrace.ExternalData.Configuration;

namespace FireTrace.ExternalData.Sources.Roads;

/// <summary>
/// As perguntas Overpass das estradas. O texto é a chave da cache em disco, por isso não pode mudar: a das estradas pavimentadas é a original
/// e os caminhos e o serviço vão numa pergunta à parte.
/// </summary>
public static class RoadQueries
{
    public static string Paved(string prefix, RoadOptions roads, string bbox)
    {
        var classes = string.Join("|", roads.PavedClasses);
        return $"{prefix}way[\"highway\"~\"^({classes})$\"]{bbox};out geom;";
    }

    /// <summary>Caminhos de serviço (sem acessos a garagens e parques) e caminhos florestais: os bombeiros usam-nos muito.</summary>
    public static string Minor(string prefix, RoadOptions roads, string bbox)
    {
        var excluded = string.Join("|", roads.ExcludedServiceTypes);
        return $"{prefix}(way[\"highway\"=\"track\"]{bbox};way[\"highway\"=\"service\"][\"service\"!~\"{excluded}\"]{bbox};);out geom;";
    }
}
