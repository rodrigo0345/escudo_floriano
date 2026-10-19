using System.Text.Json;
using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Elmfire;

/// <summary>
/// Cliente do motor ELMFIRE (contentor "engine"). Escreve a pasta de trabalho partilhada (paisagem, ajustes, meteorologia por membro),
/// chama o serviço e lê de volta os mapas de tempo de chegada, intensidade e fogo de copas.
/// </summary>
public sealed class ElmfireEngine(ElmfireClient client, ElmfireJobFiles files, ElmfireOptions options, Func<string> newJobId) : IFireEngine
{
    public Task<EngineHealth?> HealthAsync(CancellationToken ct = default) => client.HealthAsync(ct);

    public async Task<IReadOnlyDictionary<string, FireResult>> RunAsync(FireJob job, CancellationToken ct = default)
    {
        string id = newJobId(), dir = Path.Combine(options.JobsDir, id);
        Directory.CreateDirectory(dir);
        try
        {
            await files.WriteInputsAsync(dir, job, ct);
            using var response = await RunWithProgressAsync(id, job, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode) throw new EngineUnavailableException($"Motor ELMFIRE indisponível ou com erro ({(int)response.StatusCode}): {body}");
            using var doc = JsonDocument.Parse(body);
            return files.ReadResults(dir, job, doc.RootElement.GetProperty("members"));
        }
        catch (HttpRequestException e) { throw new EngineUnavailableException($"Motor ELMFIRE inacessível: {e.Message}"); }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { /* o contentor pode ainda ter ficheiros abertos */ } }
    }

    /// <summary>O motor demora minutos: de tempos a tempos pergunta-se quantos membros já acabaram.</summary>
    async Task<HttpResponseMessage> RunWithProgressAsync(string id, FireJob job, CancellationToken ct)
    {
        var post = client.StartAsync(id, ct);
        while (!post.IsCompleted)
        {
            await Task.WhenAny(post, Task.Delay(TimeSpan.FromSeconds(options.ProgressPollSeconds), ct));
            if (!post.IsCompleted && job.Progress is { } report && await client.ProgressAsync(id, ct) is { } progress) report(progress.Done, progress.Total);
        }
        return await post;
    }
}
