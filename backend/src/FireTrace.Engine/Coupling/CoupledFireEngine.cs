using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Coupling;

/// <summary>
/// Acopla o fogo ao vento: corre a corrida central sozinha, calcula o vento que esse fogo induz e corre então todos os membros com esse vento. Os membros
/// partilham o vento induzido da corrida central (as suas frentes são parecidas), o que custa 1 + N corridas em vez de 2N.
/// </summary>
public sealed class CoupledFireEngine(IFireEngine inner, ConvectionSettings convection, EngineSettings engine) : IFireEngine
{
    public Task<EngineHealth?> HealthAsync(CancellationToken ct = default) => inner.HealthAsync(ct);

    public async Task<IReadOnlyDictionary<string, FireResult>> RunAsync(FireJob job, CancellationToken ct = default)
    {
        if (!convection.Enabled || job.Members.Count == 0) return await inner.RunAsync(job, ct);
        int members = job.Members.Count, total = 1 + convection.Passes * members, bands = job.Minutes * 60 / engine.MetIntervalSeconds + 2;
        Action<int, int>? Report(int offset) => job.Progress is { } report ? (done, _) => report(offset + done, total) : null;
        var central = job.Members[0];
        var results = await inner.RunAsync(job with { Members = new[] { central }, Progress = Report(0) }, ct);
        for (int pass = 0; pass < convection.Passes; pass++)
        {
            var wind = ConvectiveWind.Field(job.Spec, results[central.Name], central.Weather, bands, engine.MetIntervalSeconds, convection);
            results = await inner.RunAsync(job with { Members = job.Members.Select(m => m with { Wind = wind }).ToList(), Progress = Report(1 + pass * members) }, ct);
        }
        return results;
    }
}
