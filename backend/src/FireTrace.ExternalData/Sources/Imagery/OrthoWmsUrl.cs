using System.Globalization;
using FireTrace.ExternalData.Configuration;

namespace FireTrace.ExternalData.Sources.Imagery;

public static class OrthoWmsUrl
{
    /// <summary>Pedido WMS 1.1.1 GetMap em EPSG:3857 para a caixa (em metros Web Mercator) e o tamanho em píxeis.</summary>
    public static string GetMap(OrthoOptions o, double minX, double minY, double maxX, double maxY, int width, int height)
    {
        var inv = CultureInfo.InvariantCulture;
        return $"{o.WmsUrl}?service=WMS&version=1.1.1&request=GetMap&layers={o.Layer}&styles=&srs=EPSG:3857" +
               $"&bbox={minX.ToString("R", inv)},{minY.ToString("R", inv)},{maxX.ToString("R", inv)},{maxY.ToString("R", inv)}&width={width}&height={height}&format=image/png";
    }
}
