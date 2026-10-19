using System.Net.Http.Headers;
using FireTrace.ExternalData.Configuration;

namespace FireTrace.ExternalData.Sources.Http;

/// <summary>Os pedidos HTTP a serviços de terceiros, com as tentativas e pausas de <see cref="HttpOptions"/>. É a única porta de saída para a rede (menos o Open-Meteo, que tem o seu cliente).</summary>
public sealed class HttpFetcher(HttpClient client, HttpOptions options)
{
    /// <summary>Tamanho de cada bloco pedido por <see cref="GetRangeAsync"/>.</summary>
    public int RangeBlockBytes => options.RangeBlockBytes;

    public async Task<byte[]> GetBytesAsync(string url, int? retries = null, CancellationToken ct = default)
    {
        int maxRetries = retries ?? options.Retries;
        for (int attempt = 0; ; attempt++)
        {
            try { return await client.GetByteArrayAsync(url, ct); }
            catch when (attempt < maxRetries && !ct.IsCancellationRequested) { await Task.Delay(options.RetryDelayMs * (attempt + 1), ct); }
        }
    }

    /// <summary>POST de um formulário (<c>application/x-www-form-urlencoded</c>); sem tentativas: quem chama decide o que repetir.</summary>
    public async Task<byte[]> PostFormAsync(string url, IReadOnlyDictionary<string, string> fields, CancellationToken ct = default)
    {
        using var content = new FormUrlEncodedContent(fields);
        return await PostAsync(url, content, ct);
    }

    public async Task<byte[]> PostJsonAsync(string url, string json, CancellationToken ct = default)
    {
        using var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
        return await PostAsync(url, content, ct);
    }

    public async Task<long> GetContentLengthAsync(string url, CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, url);
        using var response = await client.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return response.Content.Headers.ContentLength ?? throw new IOException("Sem Content-Length");
    }

    /// <summary>Os bytes <c>from..to</c> (inclusive) do recurso, com as tentativas de <see cref="HttpOptions.RangeRetries"/>.</summary>
    public async Task<byte[]> GetRangeAsync(string url, long from, long to, CancellationToken ct = default)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Range = new RangeHeaderValue(from, to);
                using var response = await client.SendAsync(request, ct);
                response.EnsureSuccessStatusCode();
                return await response.Content.ReadAsByteArrayAsync(ct);
            }
            catch when (attempt < options.RangeRetries && !ct.IsCancellationRequested) { await Task.Delay(options.RangeRetryDelayMs, ct); }
        }
    }

    async Task<byte[]> PostAsync(string url, HttpContent content, CancellationToken ct)
    {
        using var response = await client.PostAsync(url, content, ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsByteArrayAsync(ct);
    }
}
