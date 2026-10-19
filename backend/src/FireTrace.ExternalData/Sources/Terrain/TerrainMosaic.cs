using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Imaging;
using FireTrace.ExternalData.Sources.Projection;

namespace FireTrace.ExternalData.Sources.Terrain;

/// <summary>O relevo dos tiles Terrarium descarregados (um mosaico em metros), que se amostra bilinearmente para qualquer grelha.</summary>
public sealed class TerrainMosaic(float[] elevation, TileRange tiles, int zoom)
{
    int Width => tiles.MosaicWidth;

    public float[] Sample(GridSpec spec)
    {
        var o = new float[spec.Width * spec.Height];
        for (int j = 0; j < spec.Height; j++)
            for (int i = 0; i < spec.Width; i++)
            {
                var (lat, lon) = spec.ToLatLon(i, j);
                var (tx, ty) = WebMercator.TileCoordinates(lat, lon, zoom);
                double fx0 = (tx - tiles.X0) * TileRange.TilePixels - 0.5, fy0 = (ty - tiles.Y0) * TileRange.TilePixels - 0.5;
                int ix = (int)fx0, iy = (int)fy0;
                o[j * spec.Width + i] = (float)Bilinear.Sample(elevation, Width, ix, iy, fx0 - ix, fy0 - iy);
            }
        return o;
    }
}
