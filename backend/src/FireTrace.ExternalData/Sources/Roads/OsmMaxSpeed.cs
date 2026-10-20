using System.Globalization;
using System.Text.RegularExpressions;

namespace FireTrace.ExternalData.Sources.Roads;

/// <summary>O limite de velocidade de uma via OSM (`maxspeed`) em km/h; nada quando a etiqueta falta ou é simbólica (`PT:urban`, `none`, `signals`), e a via fica com a velocidade típica da sua classe.</summary>
public static partial class OsmMaxSpeed
{
    const double KmhPerMph = 1.609344, WalkKmh = 7, MinKmh = 5, MaxKmh = 140;

    [GeneratedRegex(@"^\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph)?\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex Plain();

    /// <summary>Lê `50`, `50 km/h`, `30 mph`, `walk` ou uma lista `50;30` (vale o mais baixo); valores fora de 5–140 km/h são erros de digitação e ignoram-se.</summary>
    public static double? Parse(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        var speeds = tag.Split(';').Select(One).ToList();
        return speeds.Count > 0 && speeds.All(s => s is not null) ? speeds.Min() : null;
    }

    static double? One(string part)
    {
        if (part.Trim().Equals("walk", StringComparison.OrdinalIgnoreCase)) return WalkKmh;
        var m = Plain().Match(part);
        if (!m.Success) return null;
        double value = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        if (m.Groups[2].Value.Equals("mph", StringComparison.OrdinalIgnoreCase)) value *= KmhPerMph;
        return value is >= MinKmh and <= MaxKmh ? Math.Round(value, 1) : null;
    }
}
