using BitMiracle.LibTiff.Classic;
using FireTrace.ExternalData.Sources.Http;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Leitor de pixéis de 16 bits de um COG tileado por HTTP (cache de tiles).</summary>
public sealed class Cog : IDisposable
{
    readonly Stream _stream;
    readonly Tiff _tif;
    readonly int _tw, _th, _across;
    readonly Dictionary<int, ushort[]> _tiles = new();

    Cog(Stream stream, string url)
    {
        _stream = stream;
        _tif = Tiff.ClientOpen("cog", "r", stream, new TiffStream()) ?? throw new IOException("COG inválido: " + url);
        _tw = _tif.GetField(TiffTag.TILEWIDTH)[0].ToInt(); _th = _tif.GetField(TiffTag.TILELENGTH)[0].ToInt();
        _across = (_tif.GetField(TiffTag.IMAGEWIDTH)[0].ToInt() + _tw - 1) / _tw;
    }

    public static async Task<Cog> OpenAsync(HttpFetcher http, string url, CancellationToken ct = default) =>
        new(await HttpRangeStream.OpenAsync(http, url, ct), url);

    public int Read(int x, int y)
    {
        int idx = (y / _th) * _across + x / _tw;
        if (!_tiles.TryGetValue(idx, out var t))
        {
            var buf = new byte[_tif.TileSize()];
            if (_tif.ReadEncodedTile(idx, buf, 0, buf.Length) < 0) throw new IOException("falha a ler tile do COG");
            t = new ushort[buf.Length / 2]; Buffer.BlockCopy(buf, 0, t, 0, buf.Length);
            _tiles[idx] = t;
        }
        return t[(y % _th) * _tw + x % _tw];
    }

    public void Dispose()
    {
        _tif.Dispose();
        _stream.Dispose();
    }
}
