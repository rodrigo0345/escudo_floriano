using System.Globalization;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Http;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Copernicus HRL Forest Type 2018 (10 m), via o ImageServer da EEA.</summary>
public sealed class HrlSource(HttpFetcher http, LandCoverOptions options)
{
    /// <summary>Raster 0 = sem floresta, 1 = folhosas, 2 = coníferas (255 = sem dados), na grelha pedida.</summary>
    public async Task<byte[]> ReadAsync(GeoBounds e, int w, int h)
    {
        var inv = CultureInfo.InvariantCulture;
        var url = options.HrlUrl + "?" +
                  $"bbox={e.West.ToString(inv)},{e.South.ToString(inv)},{e.East.ToString(inv)},{e.North.ToString(inv)}&bboxSR=4326&imageSR=4326&size={w},{h}&format=tiff&pixelType=U8&noData=255&interpolation=RSP_NearestNeighbor&f=image";
        return HrlRasterDecoder.Decode(await http.GetBytesAsync(url), w, h);
    }
}
