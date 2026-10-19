using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Imaging;
using FireTrace.ExternalData.Sources.Projection;

namespace FireTrace.ExternalData.Sources.Imagery;

public static class OrthoTileResampler
{
    /// <summary>
    /// Um bloco de <paramref name="tilePx"/> × <paramref name="tilePx"/> píxeis (RGBA) do mosaico Web Mercator RGB de <paramref name="mosaicPx"/> × <paramref name="mosaicPx"/>,
    /// reprojetado para a grelha lat/lon de <paramref name="b"/>. <paramref name="y0"/> e <paramref name="y1"/> são os extremos sul e norte do mosaico em metros.
    /// </summary>
    public static byte[] Resample(byte[] mosaic, int mosaicPx, double y0, double y1, GeoBounds b, int tx, int ty, int tilePx)
    {
        int M = mosaicPx;
        var px = new byte[tilePx * tilePx * 4];
        for (int j = 0; j < tilePx; j++)
        {
            int gj = ty * tilePx + j;
            double lat = b.North - (gj + 0.5) / M * (b.North - b.South);
            double my = (y1 - WebMercator.Metres(lat, b.West).Y) / (y1 - y0) * M - 0.5;
            int iy = Math.Clamp((int)Math.Floor(my), 0, M - 2); double fy = Math.Clamp(my - iy, 0, 1);
            for (int i = 0; i < tilePx; i++)
            {
                int gi = tx * tilePx + i;
                double mx = (gi + 0.5) / M * M - 0.5; // lon é linear em x do Mercator
                int ix = Math.Clamp((int)Math.Floor(mx), 0, M - 2); double fx = Math.Clamp(mx - ix, 0, 1);
                int o = (j * tilePx + i) * 4;
                for (int c = 0; c < 3; c++)
                    px[o + c] = (byte)Math.Round(Bilinear.Sample(mosaic, M, 3, ix, iy, fx, fy, c));
                px[o + 3] = 255;
            }
        }
        return px;
    }
}
