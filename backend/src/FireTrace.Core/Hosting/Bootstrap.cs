using FireTrace.Core.Common;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Fire;
using FireTrace.Core.Services.Resources;
using FireTrace.ExternalData.Ingest;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Hosting;

/// <summary>
/// Arranque em segundo plano: migra a base de dados (com tentativas, porque a base pode demorar mais que a API),
/// garante que os locais têm os dados necessários (ingest automático), semeia os cenários e aquece as simulações.
/// O servidor web já responde enquanto isto corre (documentação e saúde nunca esperam).
/// </summary>
public sealed class Bootstrap(SqlMigrator migrator, Readiness readiness, ScenarioSeeder seeder, ResourceSeeder resourceSeeder, SimulationService simulations, IDocumentStore<Simulation> sims, IMapReader map,
    IngestRunner ingest, ILogger<Bootstrap> log, DatabaseSettings database) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        for (int attempt = 1; !ct.IsCancellationRequested; attempt++)
        {
            try
            {
                await migrator.RunAsync(typeof(PostgisMapStore).Assembly, ct: ct);
                await migrator.RunAsync(typeof(Bootstrap).Assembly, "api_schema_migrations", ct);
                await seeder.SeedAsync(ct);
                await EnsureLocationsIngestedAsync(ct);
                await resourceSeeder.SeedAsync(ct);
                readiness.Database = true; readiness.Error = null;
                log.LogInformation("Base de dados pronta.");
                _ = WarmUpAsync(ct); // em segundo plano: a API já responde: não se espera aqui por simulações que podem demorar dezenas de minutos
                return;
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                readiness.Error = e.Message;
                log.LogWarning("Base de dados indisponível ({Message}); tentativa {Attempt}.", e.Message, attempt);
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(database.MaxRetryBackoffSeconds, database.RetryBackoffMultiplier * attempt)), ct);
            }
        }
    }

    /// <summary>
    /// Verifica se os locais em `locations/*.json` já têm dados de relevo na base de dados.
    /// Se nenhum estiver carregado, corre o ingest do primeiro de imediato para a API ter dados prontos.
    /// Os restantes locais em falta são carregados em segundo plano.
    /// </summary>
    async Task EnsureLocationsIngestedAsync(CancellationToken ct)
    {
        var uningested = new List<LocationDefinition>();
        bool anyReady = false;

        foreach (var location in map.Locations.All)
        {
            try
            {
                await map.GetTerrainAsync(location.Id, ct);
                anyReady = true;
            }
            catch (InvalidOperationException)
            {
                uningested.Add(location);
            }
        }

        // Se nenhum local tem relevo, carrega o primeiro antes de libertar a API
        if (!anyReady && uningested.Count > 0)
        {
            var first = uningested[0];
            uningested.RemoveAt(0);
            log.LogInformation("Nenhum local carregado na base de dados: a efetuar ingest inicial para '{Location}'…", first.Id);
            try
            {
                await ingest.RunAsync(first, new HashSet<string>(), new HashSet<string>());
                log.LogInformation("Ingest inicial concluído para '{Location}'.", first.Id);
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Falha no ingest inicial para '{Location}': {Message}", first.Id, ex.Message);
            }
        }

        // Restantes locais em falta são carregados automaticamente em segundo plano
        if (uningested.Count > 0)
        {
            _ = Task.Run(async () =>
            {
                foreach (var loc in uningested)
                {
                    if (ct.IsCancellationRequested) break;
                    log.LogInformation("A carregar dados para o local '{Location}' (ingest automático em segundo plano)…", loc.Id);
                    try
                    {
                        await ingest.RunAsync(loc, new HashSet<string>(), new HashSet<string>());
                        log.LogInformation("Ingest automático concluído para '{Location}'.", loc.Id);
                        await resourceSeeder.SeedAsync(ct);
                    }
                    catch (Exception ex)
                    {
                        log.LogError(ex, "Falha no ingest automático para '{Location}': {Message}", loc.Id, ex.Message);
                    }
                }
            }, ct);
        }
    }

    /// <summary>
    /// Deixa uma simulação já calculada para cada incidente de exemplo (`locations/*.json`), para quem abre a aplicação não ter de esperar pela
    /// primeira corrida (pode demorar dezenas de minutos num mapa grande). Só lança o que ainda não tem um resultado com sucesso; a fila do motor
    /// processa-as uma de cada vez, na ordem em que entram aqui.
    /// </summary>
    async Task WarmUpAsync(CancellationToken ct)
    {
        try
        {
            var existing = await sims.ListAsync(ct);
            foreach (var location in map.Locations.All)
            {
                try
                {
                    await map.GetTerrainAsync(location.Id, ct);
                }
                catch (InvalidOperationException)
                {
                    continue; // ainda sem relevo; salta warm-up até estar carregado
                }

                foreach (var seed in location.Incidents)
                {
                    string scenarioId = $"sc-{seed.Id}";
                    if (existing.Any(s => s.ScenarioId == scenarioId && s.Status == SimulationStatus.Succeeded)) continue;
                    log.LogInformation("A preparar uma simulação de referência para {Scenario}…", scenarioId);
                    await simulations.CreateAsync(new SimulationRequest { ScenarioId = scenarioId }, ct: ct);
                }
            }
        }
        catch (Exception e) { log.LogWarning("Não foi possível preparar simulações de referência: {Message}", e.Message); }
    }
}
