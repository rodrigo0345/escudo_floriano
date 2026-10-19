using FireTrace.Core.Common;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Fire;

namespace FireTrace.Core.Hosting;

/// <summary>Corre as simulações da fila, uma de cada vez. Ao arrancar, retoma as que ficaram à espera e dá por falhadas as que estavam a correr quando a API parou.</summary>
public sealed class SimulationWorker(SimulationQueue queue, SimulationService service, IDocumentStore<Simulation> sims, Readiness readiness, TimeProvider clock, ILogger<SimulationWorker> log, SimulationSettings settings) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!readiness.Database && !ct.IsCancellationRequested) await Task.Delay(settings.WorkerStartPollMilliseconds, ct);
        foreach (var s in await sims.ListAsync(ct))
        {
            if (s.Status == SimulationStatus.Queued) queue.Enqueue(s.Id);
            else if (s.Status == SimulationStatus.Running)
                await sims.UpsertAsync(s with { Status = SimulationStatus.Failed, FinishedAt = clock.GetUtcNow(), UpdatedAt = clock.GetUtcNow(), Error = new("A API reiniciou durante a simulação.", 500, Code: "interrupted") }, ct);
        }
        await foreach (var id in queue.ReadAllAsync(ct))
        {
            try { await service.RunAsync(id, ct); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Falha ao processar a simulação {Id}", id); }
        }
    }
}
