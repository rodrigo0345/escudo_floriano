using System.Globalization;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

public static class StacSearchBody
{
    /// <summary>O corpo JSON da pesquisa no Earth Search: a coleção, a caixa, o intervalo de datas e a nebulosidade máxima.</summary>
    public static string Build(LandCoverOptions lc, GeoBounds e, string range)
    {
        var inv = CultureInfo.InvariantCulture;
        return $"{{\"collections\":[\"{lc.EarthSearchCollection}\"],\"bbox\":[{e.West.ToString(inv)},{e.South.ToString(inv)},{e.East.ToString(inv)},{e.North.ToString(inv)}],\"datetime\":\"{range}\",\"limit\":{lc.EarthSearchLimit}," +
               $"\"query\":{{\"eo:cloud_cover\":{{\"lt\":{lc.MaxCloudCoverPct}}}}}}}";
    }
}
