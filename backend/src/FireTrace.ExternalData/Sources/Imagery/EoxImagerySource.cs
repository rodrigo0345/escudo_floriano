using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Http;
using FireTrace.ExternalData.Sources.Imaging;
using FireTrace.ExternalData.Sources.Projection;

namespace FireTrace.ExternalData.Sources.Imagery;

/// <summary>Satélite: mosaico Sentinel-2 cloudless da EOX, reprojetado de Web Mercator para a grelha lat/lon local.</summary>
public sealed class EoxImagerySource(HttpFetcher http, ImageryOptions options, ImageFileWriter images)
{
    public async Task<string> BuildAsync(GeoBounds b, int zoom, int pixels, string outPath)
    {
        var tiles = TileRange.Covering(b, zoom);
        int mw = tiles.MosaicWidth, size = TileRange.TilePixels;
        var mosaic = new byte[mw * tiles.MosaicHeight * 4];
        var coordinates = Enumerable.Range(tiles.Y0, tiles.Y1 - tiles.Y0 + 1).SelectMany(ty => Enumerable.Range(tiles.X0, tiles.X1 - tiles.X0 + 1).Select(tx => (Tx: tx, Ty: ty)));
        await Parallel.ForEachAsync(coordinates, new ParallelOptions { MaxDegreeOfParallelism = options.ConcurrentTiles }, async (tile, ct) =>
        {
            var url = options.EoxUrl.Replace("{z}", zoom.ToString()).Replace("{y}", tile.Ty.ToString()).Replace("{x}", tile.Tx.ToString());
            var image = RgbaImage.Decode(await http.GetBytesAsync(url, ct: ct));
            for (int j = 0; j < size; j++)
                image.Pixels.AsSpan(j * size * 4, size * 4).CopyTo(mosaic.AsSpan((((tile.Ty - tiles.Y0) * size + j) * mw + (tile.Tx - tiles.X0) * size) * 4));
        });
        images.SaveJpeg(EoxResampler.ToLatLonGrid(mosaic, tiles, zoom, b, pixels), pixels, pixels, options.JpegQuality, outPath);
        return outPath;
    }
}
