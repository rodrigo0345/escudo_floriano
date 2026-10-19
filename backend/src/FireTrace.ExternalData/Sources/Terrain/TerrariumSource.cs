using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Http;
using FireTrace.ExternalData.Sources.Imaging;
using FireTrace.ExternalData.Sources.Projection;

namespace FireTrace.ExternalData.Sources.Terrain;

/// <summary>Relevo: AWS Terrain Tiles (Terrarium), descarregados para um mosaico que se amostra bilinearmente para qualquer grelha.</summary>
public sealed class TerrariumSource(HttpFetcher http, TerrainOptions options)
{
    public async Task<TerrainMosaic> LoadAsync(GeoBounds bounds)
    {
        int zoom = options.TerrariumZoom;
        var tiles = TileRange.Covering(bounds, zoom);
        int mw = tiles.MosaicWidth, size = TileRange.TilePixels;
        var mosaic = new float[mw * tiles.MosaicHeight];
        for (int ty = tiles.Y0; ty <= tiles.Y1; ty++)
            for (int tx = tiles.X0; tx <= tiles.X1; tx++)
            {
                var image = RgbaImage.Decode(await http.GetBytesAsync(options.TerrariumUrl.Replace("{z}", zoom.ToString()).Replace("{x}", tx.ToString()).Replace("{y}", ty.ToString())));
                var px = image.Pixels;
                for (int j = 0; j < size; j++)
                    for (int i = 0; i < size; i++)
                    {
                        int k = (j * size + i) * 4;
                        mosaic[((ty - tiles.Y0) * size + j) * mw + (tx - tiles.X0) * size + i] = TerrariumPixel.Elevation(px[k], px[k + 1], px[k + 2]);
                    }
            }
        return new TerrainMosaic(mosaic, tiles, zoom);
    }
}
