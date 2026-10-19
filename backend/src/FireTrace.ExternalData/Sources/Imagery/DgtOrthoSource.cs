using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Ingest;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Http;
using FireTrace.ExternalData.Sources.Imaging;
using FireTrace.ExternalData.Sources.Projection;

namespace FireTrace.ExternalData.Sources.Imagery;

/// <summary>
/// Ortofotos de alta resolução da DGT (Ortofotomapa de Portugal Continental 2021, ≈0,5 m nativo), via WMS (MapProxy, EPSG:3857).
/// O mosaico é descarregado em pedidos de 1024 px, reprojetado para a grelha lat/lon local e dividido em NxN blocos JPEG
/// (cada bloco cabe numa textura WebGL; o cliente junta-os).
/// </summary>
public sealed class DgtOrthoSource(HttpFetcher http, OrthoOptions options, ImageFileWriter images, IIngestLog log)
{
    public async Task<IReadOnlyList<OrthoTile>> BuildAsync(GeoBounds b, int tiles, int tilePx, string outDir)
    {
        int M = tiles * tilePx;
        var (x0, y0) = WebMercator.Metres(b.South, b.West);
        var (x1, y1) = WebMercator.Metres(b.North, b.East);
        var mosaic = await DownloadMosaicAsync(M, x0, y0, x1, y1);

        var result = new List<OrthoTile>();
        for (int ty = 0; ty < tiles; ty++)
            for (int tx = 0; tx < tiles; tx++)
            {
                var path = Path.Combine(outDir, $"ortho_{tx}_{ty}.jpg");
                images.SaveJpeg(OrthoTileResampler.Resample(mosaic, M, y0, y1, b, tx, ty, tilePx), tilePx, tilePx, options.JpegQuality, path);
                result.Add(new OrthoTile(tx, ty, path));
            }
        return result;
    }

    /// <summary>O mosaico RGB (3 bytes por píxel) de <paramref name="M"/> × <paramref name="M"/> píxeis sobre a caixa em metros, em pedidos WMS concorrentes.</summary>
    async Task<byte[]> DownloadMosaicAsync(int M, double x0, double y0, double x1, double y1)
    {
        var mosaic = new byte[M * M * 3];
        int req = options.RequestPixels;
        int n = (M + req - 1) / req;
        var requests = Enumerable.Range(0, n).SelectMany(ry => Enumerable.Range(0, n).Select(rx => (Rx: rx, Ry: ry)));
        await Parallel.ForEachAsync(requests, new ParallelOptions { MaxDegreeOfParallelism = options.ConcurrentRequests }, async (r, ct) =>
        {
            int px0 = r.Rx * req, py0 = r.Ry * req, w = Math.Min(req, M - px0), h = Math.Min(req, M - py0);
            double bx0 = x0 + (x1 - x0) * px0 / M, bx1 = x0 + (x1 - x0) * (px0 + w) / M;
            double by1 = y1 - (y1 - y0) * py0 / M, by0 = y1 - (y1 - y0) * (py0 + h) / M;
            var bytes = await http.GetBytesAsync(OrthoWmsUrl.GetMap(options, bx0, by0, bx1, by1, w, h), options.Retries, ct);
            var image = RgbaImage.Decode(bytes, "Resposta WMS não é uma imagem (limite do servidor?)");
            for (int j = 0; j < h; j++)
                for (int i = 0; i < w; i++)
                {
                    int s = (j * image.Width + i) * 4, d = ((py0 + j) * M + px0 + i) * 3;
                    mosaic[d] = image.Pixels[s]; mosaic[d + 1] = image.Pixels[s + 1]; mosaic[d + 2] = image.Pixels[s + 2];
                }
        });
        log.Info($"  mosaico {M}x{M} descarregado ({n * n} pedidos)");
        return mosaic;
    }
}
