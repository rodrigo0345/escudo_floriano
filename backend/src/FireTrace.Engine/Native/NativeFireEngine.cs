using System.Collections.Concurrent;
using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Native;

/// <summary>
/// Motor de propagação nativo (C#, sem processo externo): Rothermel ligeiro + frente de onda elíptica pelo método do tempo mínimo de viagem.
/// Lê as mesmas entradas do ELMFIRE (<see cref="FireJob"/>: bandas de paisagem, ajuste por célula já com combustível/barreiras/riparian,
/// vento por membro, humidade do combustível) e dá a mesma saída (<see cref="FireResult"/>), por isso troca-se por <see cref="IFireEngine"/>
/// sem mudar mais nada no resto da aplicação. Não há faíscas (as barreiras já trazem a sua própria fuga) nem contentor:
/// cada membro do ensemble corre em memória, em paralelo por `workers` núcleos.
/// </summary>
public sealed class NativeFireEngine(NativeEngineSettings settings, FuelMoistureSettings moisture, int workers) : IFireEngine
{
    readonly MinimumTravelTimeSolver _solver = new(new FireBehaviorModel(settings, moisture));

    public Task<EngineHealth?> HealthAsync(CancellationToken ct = default) => Task.FromResult<EngineHealth?>(new("Native (C#)", workers));

    public async Task<IReadOnlyDictionary<string, FireResult>> RunAsync(FireJob job, CancellationToken ct = default)
    {
        var results = new ConcurrentDictionary<string, FireResult>();
        await Parallel.ForEachAsync(job.Members, new ParallelOptions { CancellationToken = ct, MaxDegreeOfParallelism = workers },
            (member, _) =>
            {
                results[member.Name] = RunMember(job, member);
                return ValueTask.CompletedTask;
            });
        return results;
    }

    FireResult RunMember(FireJob job, MemberWeather member)
    {
        var moistureByMinute = DeadFuelMoisture.Series(member.Weather, 60, job.Minutes + 1, moisture, 0, job.FuelMoisture); // uma linha por minuto (dt = 60 s)
        return _solver.Solve(job, member, moistureByMinute);
    }
}
