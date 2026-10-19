using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Ingest;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Http;

namespace FireTrace.ExternalData.Sources.Overpass;

/// <summary>
/// Cliente do Overpass (OpenStreetMap). Cada pedido fica em cache em disco (pelo texto da pergunta), por isso um ingest interrompido retoma
/// sem repetir os blocos já descarregados, e vários servidores são tentados à vez porque os públicos falham com frequência.
/// </summary>
public sealed class OverpassClient(HttpFetcher http, OverpassCache cache, OverpassOptions options, IIngestLog log)
{
    /// <summary>Cabeçalho comum das perguntas (formato JSON e limite de tempo do servidor), com o limite pedido ou o das opções.</summary>
    public string Prefix(int? timeoutSeconds = null) => $"[out:json][timeout:{timeoutSeconds ?? options.QueryTimeoutSeconds}];";

    public async Task<JsonDocument> QueryAsync(string query, CancellationToken ct = default)
    {
        if (await cache.TryReadAsync(query, ct) is { } cached) return JsonDocument.Parse(cached);
        Exception? last = null;
        var form = new Dictionary<string, string> { ["data"] = query };
        for (int attempt = 0; attempt < options.MaxAttempts; attempt++)
        {
            var endpoint = options.Endpoints[attempt % options.Endpoints.Length];
            try
            {
                var bytes = await http.PostFormAsync(endpoint, form, ct);
                var doc = JsonDocument.Parse(bytes); // valida antes de guardar
                await cache.WriteAsync(query, bytes, ct);
                return doc;
            }
            catch (Exception e)
            {
                last = e;
                log.Warn($"  overpass {endpoint} falhou ({e.Message}); a repetir…");
                await Task.Delay(TimeSpan.FromSeconds(options.RetryDelaySeconds * (attempt + 1)), ct);
            }
        }
        throw new InvalidOperationException("Overpass indisponível", last);
    }

    /// <summary>
    /// Percorre o local em blocos (áreas grandes falham ou expiram num único pedido) e regista o progresso: <paramref name="processBlock"/> faz as perguntas
    /// do bloco e devolve o resumo do que já foi reunido (por exemplo «120 vias»).
    /// </summary>
    public async Task ForEachBlockAsync(GridSpec spec, double maxBlockM, Func<GeoBounds, Task<string>> processBlock)
    {
        foreach (var block in GridBlockSplitter.Split(spec, maxBlockM))
            log.Info($"  bloco {block.Index}/{block.Total}: {await processBlock(block.Box)}");
    }
}
