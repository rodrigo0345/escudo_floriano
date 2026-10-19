using BitMiracle.LibTiff.Classic;

namespace FireTrace.ExternalData.Sources.Vegetation;

public static class HrlRasterDecoder
{
    /// <summary>Descodifica o TIFF de 8 bits do HRL (às tiras ou aos tiles) para um raster <paramref name="w"/> × <paramref name="h"/>.</summary>
    public static byte[] Decode(byte[] tiff, int w, int h)
    {
        using var ms = new MemoryStream(tiff);
        using var tif = Tiff.ClientOpen("hrl", "r", ms, new TiffStream()) ?? throw new IOException("TIFF HRL inválido");
        int tw = tif.GetField(TiffTag.IMAGEWIDTH)[0].ToInt(), th = tif.GetField(TiffTag.IMAGELENGTH)[0].ToInt();
        if (tw != w || th != h) throw new IOException($"HRL com dimensões inesperadas {tw}x{th}");
        var res = new byte[w * h];
        if (tif.IsTiled())
        {
            int tcw = tif.GetField(TiffTag.TILEWIDTH)[0].ToInt(), tl = tif.GetField(TiffTag.TILELENGTH)[0].ToInt();
            var buf = new byte[tif.TileSize()];
            for (int ty = 0; ty < h; ty += tl)
                for (int tx = 0; tx < w; tx += tcw)
                {
                    if (tif.ReadTile(buf, 0, tx, ty, 0, 0) < 0) throw new IOException("falha a ler tile HRL");
                    for (int j = 0; j < tl && ty + j < h; j++) for (int i = 0; i < tcw && tx + i < w; i++) res[(ty + j) * w + tx + i] = buf[j * tcw + i];
                }
        }
        else
        {
            var row = new byte[tif.ScanlineSize()];
            for (int y = 0; y < h; y++) { if (!tif.ReadScanline(row, y)) throw new IOException("falha a ler linha HRL"); Buffer.BlockCopy(row, 0, res, y * w, Math.Min(w, row.Length)); }
        }
        return res;
    }
}
