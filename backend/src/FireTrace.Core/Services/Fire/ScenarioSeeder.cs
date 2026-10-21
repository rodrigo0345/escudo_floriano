using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Fire;

/// <summary>Os incêndios de exemplo dos ficheiros `locations/*.json` passam a cenários `builtin` (a lista de arranque do frontend).</summary>
public sealed class ScenarioSeeder(IMapReader map, IDocumentStore<Scenario> store, TimeProvider clock)
{
    public async Task SeedAsync(CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();
        foreach (var location in map.Locations.All)
            foreach (var seed in location.Incidents)
            {
                var scenario = new Scenario
                {
                    Id = $"sc-{seed.Id}", CreatedAt = now, UpdatedAt = now, Builtin = true, Name = seed.Name, Description = seed.Notes, LocationId = location.Id,
                    Purpose = seed.Historical ? ScenarioPurpose.HistoricalReplay : ScenarioPurpose.Planning, Start = seed.Start, DurationMinutes = seed.DurationMinutes,
                    Ignitions = new() { new Ignition(new LatLon(seed.Lat, seed.Lon), Label: seed.Name) },
                    Weather = seed.Id.Contains("penha")
                        ? Manual(35, 335, 55, 35, 17, seed.DurationMinutes, 33, 20)
                        : Manual(12, 320, 22, 32, 25, seed.DurationMinutes, 29, 30),
                    Resources = new ScenarioResources("none"),
                    Engine = new EngineOptions(new EnsembleSpec()), Tags = new() { "builtin" },
                };
                // Uma semente só é criada se faltar: um reinício não deve apagar a meteorologia manual nem outras edições do utilizador.
                if (await store.GetAsync(scenario.Id, ct) is null) await store.UpsertAsync(scenario, ct);
            }

        // Cenários operacionais detalhados para treino e planeamento tático
        var richScenarios = new List<Scenario>
        {
            new()
            {
                Id = "sc-penha-exercicio-rotacao-vento",
                CreatedAt = now,
                UpdatedAt = now,
                Builtin = true,
                Name = "Exercício Penha — Rotação de Vento e Defesa Perimétrica",
                Description = "Cenário tático de treino operacional: ignição na encosta sudoeste da Penha em condições de verão extremo (34 °C), com rotação de vento de 90° para nascente aos 60 minutos e rajadas de 45 km/h. Exige reposicionamento dinâmico de meios, corte de estradas e defesa de estruturas.",
                LocationId = "guimaraes",
                Purpose = ScenarioPurpose.Exercise,
                Start = DateTimeOffset.Parse("2026-08-17T14:30:00+01:00"),
                DurationMinutes = 180,
                Ignitions = new() { new Ignition(new LatLon(41.4298, -8.2686), Label: "Encosta Sudoeste da Penha") },
                Weather = Manual(18, 315, 35, 34, 20, 180, 32, 24) with
                {
                    Events = new()
                    {
                        new WindShiftEvent
                        {
                            Start = new TimeSpec { OffsetMinutes = 60 },
                            DeltaDeg = 90,
                            RampMinutes = 15,
                            HoldMinutes = 60
                        },
                        new GustBurstEvent
                        {
                            Window = new TimeWindow(
                                new TimeSpec { OffsetMinutes = 60 },
                                new TimeSpec { OffsetMinutes = 120 }
                            ),
                            PeakGustKmh = 45
                        }
                    }
                },
                Resources = new ScenarioResources("all"),
                Engine = new EngineOptions(new EnsembleSpec()),
                Tags = new() { "builtin", "exercise", "penha", "wind-shift" }
            },
            new()
            {
                Id = "sc-falperra-interface",
                CreatedAt = now,
                UpdatedAt = now,
                Builtin = true,
                Name = "Falperra — Interface Urbano-Florestal e Proteção de Povoações",
                Description = "Incêndio florestal de rápida propagação em eucaliptal na encosta poente da Serra da Falperra. O fogo avança em direção a aglomerados habitacionais em Santa Marta e Caldelas/Taipas, exigindo ativação de faixas corta-fogo e proteção de habitações.",
                LocationId = "guimaraes-concelho",
                Purpose = ScenarioPurpose.Planning,
                Start = DateTimeOffset.Parse("2026-08-18T13:00:00+01:00"),
                DurationMinutes = 240,
                Ignitions = new() { new Ignition(new LatLon(41.5143, -8.3947), Label: "Santa Marta das Cortiças (Falperra)") },
                Weather = Manual(20, 300, 40, 33, 22, 240, 30, 28),
                Resources = new ScenarioResources("all"),
                Engine = new EngineOptions(new EnsembleSpec()),
                Tags = new() { "builtin", "interface", "falperra", "taipas", "planning" }
            },
            new()
            {
                Id = "sc-lustoso-noite",
                CreatedAt = now,
                UpdatedAt = now,
                Builtin = true,
                Name = "Santa Marinha / Lustoso — Ataque Noturno e Contenção em Faixas Corta-Fogo",
                Description = "Incêndio de fim de tarde em zona montanhosa a nordeste do concelho. Demonstração de contenção noturna ancorada em caminhos florestais e aceiros (faixas corta-fogo grade 4/5) com aumento de humidade relativa durante a noite.",
                LocationId = "guimaraes-concelho",
                Purpose = ScenarioPurpose.Research,
                Start = DateTimeOffset.Parse("2026-08-19T19:00:00+01:00"),
                DurationMinutes = 300,
                Ignitions = new() { new Ignition(new LatLon(41.5032, -8.2247), Label: "Lustoso / Santa Marinha") },
                Weather = Manual(10, 310, 20, 28, 35, 300, 18, 60),
                Resources = new ScenarioResources("all"),
                Engine = new EngineOptions(new EnsembleSpec()),
                Tags = new() { "builtin", "night", "firebreaks", "containment" }
            }
        };

        foreach (var sc in richScenarios)
            if (await store.GetAsync(sc.Id, ct) is null) await store.UpsertAsync(sc, ct);
    }

    /// <summary>Perfil manual (sem Open-Meteo): um ponto inicial e outro no fim, com transição suave.</summary>
    static WeatherSpec Manual(double windKmh, double windFromDeg, double gustKmh, double tempC, double humidityPct, int durationMinutes, double endTempC, double endHumidityPct) => new()
    {
        Base = WeatherBase.None,
        Keyframes = new()
        {
            new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: 0), WindKmh = windKmh, WindFromDeg = windFromDeg, GustKmh = gustKmh, TempC = tempC, HumidityPct = humidityPct },
            new WeatherKeyframe { At = new TimeSpec(OffsetMinutes: durationMinutes), WindKmh = windKmh, WindFromDeg = windFromDeg, GustKmh = gustKmh, TempC = endTempC, HumidityPct = endHumidityPct, Transition = "smooth" },
        },
    };
}
