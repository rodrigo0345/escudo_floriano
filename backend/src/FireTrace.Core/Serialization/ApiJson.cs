using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Serialization;

/// <summary>Opções JSON únicas da API: camelCase, enumerações em snake_case e geometrias GeoJSON. Usadas pelos pedidos, pelas respostas e pela base de dados.</summary>
public static class ApiJson
{
    public static readonly JsonSerializerOptions Options = Configure(new JsonSerializerOptions(JsonSerializerDefaults.Web));

    public static JsonSerializerOptions Configure(JsonSerializerOptions o)
    {
        o.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        o.NumberHandling = JsonNumberHandling.AllowReadingFromString;
        o.AllowOutOfOrderMetadataProperties = true; // `type`/`kind` podem vir em qualquer posição do objeto
        o.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower));
        o.Converters.Add(new GeoJsonConverter());
        return o;
    }
}
