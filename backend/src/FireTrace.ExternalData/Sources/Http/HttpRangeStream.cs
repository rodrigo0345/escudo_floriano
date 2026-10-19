namespace FireTrace.ExternalData.Sources.Http;

/// <summary>
/// Stream só de leitura sobre HTTP com cache de blocos, para ler COGs sem os descarregar inteiros. A leitura é síncrona porque o leitor de TIFF
/// (LibTiff) só sabe ler assim; cada bloco novo bloqueia até chegar.
/// </summary>
public sealed class HttpRangeStream : Stream
{
    readonly HttpFetcher _http;
    readonly string _url;
    readonly int _block;
    readonly Dictionary<long, byte[]> _cache = new();
    long _pos;

    HttpRangeStream(HttpFetcher http, string url, long length)
    {
        _http = http; _url = url; Length = length; _block = http.RangeBlockBytes;
    }

    public static async Task<HttpRangeStream> OpenAsync(HttpFetcher http, string url, CancellationToken ct = default) =>
        new(http, url, await http.GetContentLengthAsync(url, ct));

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length { get; }
    public override long Position { get => _pos; set => _pos = value; }
    public override void Flush() { }

    public override int Read(byte[] buffer, int offset, int count)
    {
        int done = 0;
        while (done < count && _pos < Length)
        {
            long bi = _pos / _block;
            if (!_cache.TryGetValue(bi, out var blk))
            {
                long from = bi * _block, to = Math.Min(from + _block, Length) - 1;
                blk = _cache[bi] = _http.GetRangeAsync(_url, from, to).GetAwaiter().GetResult();
            }
            int off = (int)(_pos - bi * _block), n = Math.Min(count - done, blk.Length - off);
            Buffer.BlockCopy(blk, off, buffer, offset + done, n);
            done += n; _pos += n;
        }
        return done;
    }

    public override long Seek(long offset, SeekOrigin origin) =>
        _pos = origin switch { SeekOrigin.Begin => offset, SeekOrigin.Current => _pos + offset, _ => Length + offset };

    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
