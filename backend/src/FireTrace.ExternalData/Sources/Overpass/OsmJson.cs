using System.Text.Json;

namespace FireTrace.ExternalData.Sources.Overpass;

/// <summary>Leitura dos elementos JSON que o Overpass devolve.</summary>
public static class OsmJson
{
    /// <summary>Valor de uma etiqueta OSM do elemento, se existir.</summary>
    public static string? Tag(JsonElement el, string key) => el.TryGetProperty("tags", out var t) && t.TryGetProperty(key, out var v) ? v.GetString() : null;

    public static IEnumerable<JsonElement> Elements(JsonDocument doc) => doc.RootElement.GetProperty("elements").EnumerateArray();

    /// <summary>
    /// Posição de um elemento: o `center` (vias e relações), as coordenadas do nó ou, com `out center bb`, o centro da caixa `bounds`
    /// (o Overpass só devolve `bounds` nas vias).
    /// </summary>
    public static (double Lat, double Lon)? Position(JsonElement el)
    {
        if (el.TryGetProperty("center", out var c)) return (c.GetProperty("lat").GetDouble(), c.GetProperty("lon").GetDouble());
        if (el.TryGetProperty("lat", out var la) && el.TryGetProperty("lon", out var lo)) return (la.GetDouble(), lo.GetDouble());
        if (el.TryGetProperty("bounds", out var b))
            return ((b.GetProperty("minlat").GetDouble() + b.GetProperty("maxlat").GetDouble()) / 2, (b.GetProperty("minlon").GetDouble() + b.GetProperty("maxlon").GetDouble()) / 2);
        return null;
    }
}
