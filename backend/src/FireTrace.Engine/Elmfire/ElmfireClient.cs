using System.Text.Json;
using System.Text;
using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Elmfire;

/// <summary>The HTTP side of the ELMFIRE container: health, run a prepared job folder, and how many members have finished.</summary>
public sealed class ElmfireClient(HttpClient http, ElmfireOptions options)
{
    public async Task<EngineHealth?> HealthAsync(CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(options.HealthTimeoutSeconds));
            using var doc = JsonDocument.Parse(await http.GetStringAsync($"{options.EngineUrl}/health", cts.Token));
            return doc.RootElement.GetProperty("elmfire").GetBoolean() ? new EngineHealth("ELMFIRE", doc.RootElement.GetProperty("workers").GetInt32()) : null;
        }
        catch { return null; }
    }

    /// <summary>Starts the job (it runs for minutes) and returns the pending request, so the caller can poll <see cref="ProgressAsync"/> meanwhile.</summary>
    public Task<HttpResponseMessage> StartAsync(string jobId, CancellationToken ct) =>
        // com Content-Length: o serviço Python não lê pedidos "chunked"
        http.PostAsync($"{options.EngineUrl}/run", new StringContent(JsonSerializer.Serialize(new { job = jobId }), Encoding.UTF8, "application/json"), ct);

    /// <summary>Quantos membros do trabalho já têm resultado (o motor conta os ficheiros `toa.i16`).</summary>
    public async Task<(int Done, int Total)?> ProgressAsync(string jobId, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(await http.GetStringAsync($"{options.EngineUrl}/progress/{jobId}", ct));
            return (doc.RootElement.GetProperty("done").GetInt32(), doc.RootElement.GetProperty("total").GetInt32());
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or KeyNotFoundException) { return null; } // só informativo: um motor sem esta rota não impede a simulação
    }
}
