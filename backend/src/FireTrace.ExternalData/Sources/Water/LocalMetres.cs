using System.Text.Json;

namespace FireTrace.ExternalData.Sources.Water;

/// <summary>Metros por grau perto do equador e áreas aproximadas, suficientes para massas de água de dezenas a milhares de m².</summary>
public static class LocalMetres
{
    public const double PerDegreeLat = 110574, PerDegreeLonAtEquator = 111320;

    /// <summary>Área em m² da caixa `bounds` do Overpass.</summary>
    public static double BoxAreaM2(JsonElement b)
    {
        double s = b.GetProperty("minlat").GetDouble(), n = b.GetProperty("maxlat").GetDouble(), w = b.GetProperty("minlon").GetDouble(), e = b.GetProperty("maxlon").GetDouble();
        return (n - s) * PerDegreeLat * (e - w) * PerDegreeLonAtEquator * Math.Cos((n + s) / 2 * Math.PI / 180);
    }
}
