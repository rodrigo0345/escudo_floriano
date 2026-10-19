using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Water;

/// <summary>Leitura das etiquetas OSM que os pontos de água usam.</summary>
public static class WaterTags
{
    /// <summary>O primeiro número do texto (vírgula decimal aceite), por exemplo «100 mm» → 100.</summary>
    public static double? Num(string? s)
    {
        if (s is null) return null;
        var m = Regex.Match(s, @"[-+]?\d+(?:[.,]\d+)?");
        return m.Success && double.TryParse(m.Value.Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
    }

    public static string AccessOf(JsonElement el) => (OsmJson.Tag(el, "access") ?? "unknown") switch
    {
        "yes" or "public" or "permissive" => "public",
        "private" or "no" => "private",
        var a => a is "customers" or "permit" or "restricted" ? "restricted" : "unknown",
    };
}
