using BitMiracle.LibTiff.Classic;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Http;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Uso do solo: ESA WorldCover 2021 (10 m), lido por janela diretamente do COG na AWS (pedidos HTTP Range).</summary>
public sealed class WorldCoverSource(HttpFetcher http, LandCoverOptions options)
{
    /// <summary>Janela WorldCover (códigos ESA, ~7×9 m por píxel) que cobre a grelha, com a sua extensão geográfica exata.</summary>
    public async Task<WorldCoverWindow> ReadWindowAsync(GridSpec spec)
    {
        var b = spec.Bounds;
        int deg = options.WorldCoverTileDegrees;
        var tile = WorldCoverTiling.Locate(b, deg);
        using var stream = await HttpRangeStream.OpenAsync(http, options.WorldCoverUrl.Replace("{tile}", tile.Name));
        using var tif = Tiff.ClientOpen("worldcover", "r", stream, new TiffStream()) ?? throw new IOException("Não foi possível abrir o COG WorldCover.");
        int W = tif.GetField(TiffTag.IMAGEWIDTH)[0].ToInt(), H = tif.GetField(TiffTag.IMAGELENGTH)[0].ToInt();
        int tw = tif.GetField(TiffTag.TILEWIDTH)[0].ToInt(), th = tif.GetField(TiffTag.TILELENGTH)[0].ToInt();
        var window = WorldCoverTiling.WindowOf(b, tile, deg, W, H);
        int ww = window.Width, hh = window.Height;
        var arr = new byte[ww * hh];
        var buf = new byte[tif.TileSize()];
        for (int ty = window.Ya / th; ty <= (window.Yb - 1) / th; ty++)
            for (int tx = window.Xa / tw; tx <= (window.Xb - 1) / tw; tx++)
            {
                if (tif.ReadTile(buf, 0, tx * tw, ty * th, 0, 0) < 0) throw new IOException("Falha ao ler tile WorldCover.");
                for (int j = 0; j < th; j++)
                {
                    int gy = ty * th + j - window.Ya;
                    if (gy < 0 || gy >= hh) continue;
                    for (int i = 0; i < tw; i++)
                    {
                        int gx = tx * tw + i - window.Xa;
                        if (gx >= 0 && gx < ww) arr[gy * ww + gx] = buf[j * tw + i];
                    }
                }
            }
        return new WorldCoverWindow(arr, ww, hh, window.Extent);
    }
}
