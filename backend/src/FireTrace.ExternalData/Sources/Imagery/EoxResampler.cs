using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Imaging;
using FireTrace.ExternalData.Sources.Projection;

namespace FireTrace.ExternalData.Sources.Imagery;

public static class EoxResampler
{
    /// <summary>Reprojeta o mosaico de tiles Web Mercator (RGBA) para a grelha lat/lon de <paramref name="pixels"/> × <paramref name="pixels"/> sobre <paramref name="b"/>.</summary>
    public static byte[] ToLatLonGrid(byte[] mosaic, TileRange tiles, int zoom, GeoBounds b, int pixels)
    {
        int mw = tiles.MosaicWidth, mh = tiles.MosaicHeight, size = TileRange.TilePixels;
        var outPx = new byte[pixels * pixels * 4];
        for (int j = 0; j < pixels; j++)
        {
            double lat = b.North - (j + 0.5) / pixels * (b.North - b.South);
            for (int i = 0; i < pixels; i++)
            {
                double lon = b.West + (i + 0.5) / pixels * (b.East - b.West);
                var (tx, ty) = WebMercator.TileCoordinates(lat, lon, zoom);
                double fx0 = tx * size - tiles.X0 * size - 0.5, fy0 = ty * size - tiles.Y0 * size - 0.5;
                int ix = Math.Clamp((int)fx0, 0, mw - 2), iy = Math.Clamp((int)fy0, 0, mh - 2);
                double fx = Math.Clamp(fx0 - ix, 0, 1), fy = Math.Clamp(fy0 - iy, 0, 1);
                for (int c = 0; c < 4; c++)
                    outPx[(j * pixels + i) * 4 + c] = (byte)Math.Round(Bilinear.Sample(mosaic, mw, 4, ix, iy, fx, fy, c));
            }
        }
        return outPx;
    }
}
