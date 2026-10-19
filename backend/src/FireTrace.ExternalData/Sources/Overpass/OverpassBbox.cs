using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Overpass;

public static class OverpassBbox
{
    /// <summary>Caixa Overpass `(sul,oeste,norte,este)`, com margem opcional em graus.</summary>
    public static string Of(GeoBounds b, double pad = 0) => FormattableString.Invariant($"({b.South - pad:F5},{b.West - pad:F5},{b.North + pad:F5},{b.East + pad:F5})");
}
