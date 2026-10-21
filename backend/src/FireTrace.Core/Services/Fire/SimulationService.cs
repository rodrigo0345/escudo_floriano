using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using FireTrace.Core.Common;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.Fuel;
using FireTrace.Core.Domain.Interventions;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Operations;
using FireTrace.Core.Services.Weather;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Fire;

/// <summary>
/// Orquestra uma simulação de fogo: junta o cenário, o terreno (vegetação, edifícios, estradas, aceiros), a meteorologia e as decisões,
/// entrega-os ao motor (ELMFIRE) e guarda o resultado para as consultas (`FireResults`).
/// </summary>
public sealed class SimulationService(IDocumentStore<Simulation> sims, IDocumentStore<Scenario> scenarios, IMapReader map, WeatherService weather, IFireEngine engine, IFireRunRepository runs,
    TimeProvider clock, IIdGenerator ids, SimulationQueue queue, IEnumerable<IInterventionProvider> providers, FireTraceSettings settings, LandscapeBuilder landscapeBuilder, FuelCatalog fuels,
    IDocumentStore<Plan> plans, CrewSafety crewSafety)
{
    readonly ConditionalWeakTable<TerrainGrids, Lazy<Task<Landscape>>> _landscapes = new();
    readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new();

    // ===================================================================================================== pedir e consultar
    public async Task<Simulation> CreateAsync(SimulationRequest request, string? parentSimulationId = null, CancellationToken ct = default)
    {
        var scenario = request.Scenario ?? (request.ScenarioId is { } sid ? await scenarios.GetAsync(sid, ct) ?? throw new NotFoundException($"Cenário '{sid}'")
            : throw new ValidationException("Indique `scenarioId` ou `scenario`.", "/scenarioId"));
        Validate(scenario);
        var now = clock.GetUtcNow();
        if (request.Scenario is not null) scenario = scenario with { Id = "inline", CreatedAt = now, UpdatedAt = now };
        if (request.Engine is { } engineOptions) scenario = scenario with { Engine = engineOptions };
        var id = ids.New("sim");
        var sim = new Simulation
        {
            Id = id, CreatedAt = now, UpdatedAt = now, Label = request.Label, Kind = request.Kind, ScenarioId = request.ScenarioId, ScenarioSnapshot = scenario, PlanId = request.PlanId, ParentSimulationId = parentSimulationId,
            LocationId = scenario.LocationId, Status = SimulationStatus.Queued, Progress = new("queued", 0), Links = Links(id),
            Tags = request.IncludeActiveDispatches ? new() { "with-dispatches" } : null,
        };
        await sims.UpsertAsync(sim, ct);
        queue.Enqueue(id);
        return sim;
    }

    public async Task<Simulation> GetAsync(string id, CancellationToken ct = default) => await sims.GetAsync(id, ct) ?? throw new NotFoundException($"Simulação '{id}'");

    public async Task<Simulation> WaitAsync(string id, int seconds, CancellationToken ct = default)
    {
        var until = clock.GetUtcNow().AddSeconds(Math.Clamp(seconds, 0, settings.Limits.MaxWaitSeconds));
        var sim = await GetAsync(id, ct);
        while (sim.Status is SimulationStatus.Queued or SimulationStatus.Running && clock.GetUtcNow() < until)
        {
            await Task.Delay(settings.Simulation.WaitPollMilliseconds, ct);
            sim = await GetAsync(id, ct);
        }
        return sim;
    }

    public async Task<Simulation> CancelAsync(string id, CancellationToken ct = default)
    {
        var sim = await GetAsync(id, ct);
        if (sim.Status is not (SimulationStatus.Queued or SimulationStatus.Running)) throw new ConflictException($"A simulação já está '{sim.Status}'.", "invalid_transition");
        if (_running.TryGetValue(id, out var cts)) cts.Cancel();
        return await Save(sim with { Status = SimulationStatus.Cancelled, FinishedAt = clock.GetUtcNow(), Progress = new("done", sim.Progress?.Percent ?? 0) });
    }

    public async Task DeleteAsync(string id, CancellationToken ct = default)
    {
        var sim = await GetAsync(id, ct);
        if (_running.TryGetValue(id, out var cts)) cts.Cancel();
        await runs.DeleteAsync(id, ct);
        await sims.DeleteAsync(sim.Id, ct);
    }

    public async Task<Page<Simulation>> PageAsync(PageQuery page, Func<Simulation, bool> filter, CancellationToken ct = default) =>
        page.Apply((await sims.ListAsync(ct)).Where(filter).OrderByDescending(s => s.CreatedAt).ToList(), s => s.UpdatedAt);

    static Dictionary<string, string> Links(string id)
    {
        string b = $"/api/v1/simulations/{id}";
        return new() { ["summary"] = $"{b}/summary", ["perimeters"] = $"{b}/perimeters", ["vectors"] = $"{b}/vectors", ["impact"] = $"{b}/impact", ["roadStatus"] = $"{b}/road-status",
            ["placeAccess"] = $"{b}/place-access", ["threatened"] = $"{b}/threatened", ["smoke"] = $"{b}/smoke", ["units"] = $"{b}/units", ["weather"] = $"{b}/weather", ["grids"] = $"{b}/grids/ignition" };
    }

    void Validate(Scenario s)
    {
        var loc = map.Locations.Find(s.LocationId) ?? throw new ValidationException($"Local '{s.LocationId}' desconhecido.", "/locationId");
        var (dMin, dMax, ignMin, ignMax) = (settings.Limits.MinDurationMinutes, settings.Limits.MaxDurationMinutes, settings.Limits.MinIgnitions, settings.Limits.MaxIgnitions);
        if (s.DurationMinutes < dMin || s.DurationMinutes > dMax) throw new ValidationException($"durationMinutes deve estar entre {dMin} e {dMax}.", "/durationMinutes");
        if (s.Ignitions.Count < ignMin || s.Ignitions.Count > ignMax) throw new ValidationException($"Indique entre {ignMin} e {ignMax} ignições.", "/ignitions");
        for (int i = 0; i < s.Ignitions.Count; i++)
            if (loc.Spec.CellAt(s.Ignitions[i].Position.Lat, s.Ignitions[i].Position.Lon) < 0) throw new ValidationException("A ignição está fora da área do local.", $"/ignitions/{i}/position");
    }

    // ===================================================================================================== execução (chamada pela fila)
    public async Task RunAsync(string id, CancellationToken stopping)
    {
        var sim = await sims.GetAsync(id, stopping);
        if (sim is null || sim.Status != SimulationStatus.Queued) return; // cancelada ou apagada enquanto esperava
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        _running[id] = cts;
        try
        {
            sim = await Save(sim with { Status = SimulationStatus.Running, StartedAt = clock.GetUtcNow(), Progress = new("preparing", settings.Simulation.ProgressPercent.Preparing) });
            var run = await ExecuteAsync(sim, cts.Token);
            await runs.SaveAsync(run, cts.Token);
            var current = await sims.GetAsync(id, CancellationToken.None);
            if (current?.Status == SimulationStatus.Cancelled) { await runs.DeleteAsync(id, CancellationToken.None); return; }
            var stats = Stats(run, await map.GetTerrainAsync(sim.LocationId, CancellationToken.None));
            // a plan's what-if also answers "who is caught in this fire?" (the rule lives in CrewSafety; where to put crews is the planner's call)
            var exposures = sim.PlanId is { } planId && await plans.GetAsync(planId, CancellationToken.None) is { } plan ? await crewSafety.EvaluateAsync(plan, run, CancellationToken.None) : null;
            if (exposures is not null) stats = stats with { CrewCasualties = exposures.Sum(e => e.Casualties) };
            await Save(sim with { Status = SimulationStatus.Succeeded, FinishedAt = clock.GetUtcNow(), Progress = new("done", 100, run.Members.Length, run.Members.Length), Stats = stats, CrewExposures = exposures });
        }
        catch (OperationCanceledException) { /* cancelada: o estado já foi atualizado por CancelAsync */ }
        catch (Exception e)
        {
            var problem = e is ApiException a ? new ProblemInfo(a.Message, a.Status, Code: a.Code) : new ProblemInfo("Erro inesperado na simulação.", 500, e.Message, "internal_error");
            await Save(sim! with { Status = SimulationStatus.Failed, FinishedAt = clock.GetUtcNow(), Error = problem, Progress = new("done", 0) });
        }
        finally { _running.TryRemove(id, out _); }
    }

    async Task<FireRun> ExecuteAsync(Simulation sim, CancellationToken ct)
    {
        var sc = sim.ScenarioSnapshot;
        var terrain = await map.GetTerrainAsync(sc.LocationId, ct);
        var net = await map.GetRoadsAsync(sc.LocationId, ct);
        var places = await map.GetPlacesAsync(sc.LocationId, ct);
        var landscape = await _landscapes.GetValue(terrain, t => new Lazy<Task<Landscape>>(async () =>
            landscapeBuilder.Build(t, net, await map.GetFirebreaksAsync(sc.LocationId, ct), await map.GetWaterwaysAsync(sc.LocationId, ct)))).Value;

        var interventions = new List<Intervention>(sc.Interventions ?? new());
        foreach (var p in providers)
        {
            if (sim.PlanId is { } planId) interventions.AddRange(await p.ForPlanAsync(planId, ct));
            if (sim.Tags?.Contains("with-dispatches") == true) interventions.AddRange(await p.ForActiveDispatchesAsync(sc.LocationId, ct));
        }
        bool timed = settings.Engine.Provider != "elmfire"; // o ELMFIRE não aceita tempo: aí tudo vale desde o início
        var effect = InterventionApplier.Apply(interventions, terrain, places, landscape.Adjustment, settings.Rules.Suppression, settings.Interventions, sc.Start, timed);

        var spec = terrain.Spec;
        var ignitions = sc.Ignitions.Select(i => ToIgnitionCell(terrain, i)).ToList();
        var ensemble = ResolvedEnsemble.Of(sc.Engine?.Ensemble ?? sc.Weather?.Ensemble, settings.Defaults.Ensemble);
        if (sc.Engine?.Seed is { } seed) ensemble = ensemble with { Seed = seed };
        var wspec = sc.Weather ?? new WeatherSpec();
        var track = await weather.BuildTrackAsync(sc.LocationId, wspec, sc.Start, sc.DurationMinutes, ct);
        var members = new List<MemberWeather> { new("rep", track) };
        members.AddRange(Ensemble.Members(track, ensemble, ensemble.Members, settings.Limits.MaxEnsembleMembers));
        members = members.Select((m, i) => m with { Adjustment = ApplyBarriers(landscape.Barriers, effect.Adjustment, m.Weather, sc.DurationMinutes, ensemble.Seed + i) }).ToList();

        bool[]? burned = null;
        if (sc.InitialFire is { } initial)
        {
            burned = new bool[spec.CellCount];
            foreach (var c in Zones.CellsOf(spec, initial.Perimeter, 0)) burned[c] = true;
        }

        await Save(sim with { Progress = new("running_members", settings.Simulation.ProgressPercent.RunningMembers, 0, members.Count) });
        var report = Progress(sim.Id, members.Count, ct);
        var results = await engine.RunAsync(new FireJob(spec.ToEngineGrid(), landscapeBuilder.Treat(landscape.Bands, spec.CellCount, effect.Treatments, settings.Interventions.FuelRemoval), effect.Adjustment, ignitions, sc.DurationMinutes, members, weather.SpinUpHours(wspec) * 60, sc.Engine?.Spotting ?? settings.Defaults.Spotting, burned, wspec.FuelMoisture, report.Report,
            effect.Windows is { Count: > 0 } w ? new SuppressionPlan(w, settings.Rules.Suppression.FullEffectUpToKwm, settings.Rules.Suppression.NoEffectFromKwm, settings.Interventions.MinSpreadFactor,
                settings.Interventions.LineHoldFullKwm, settings.Interventions.LineBreachKwm) : null), ct);
        await report.Idle(); // sem gravações de progresso atrasadas por cima do estado seguinte
        await Save(await GetAsync(sim.Id, ct) with { Progress = new("post_processing", settings.Simulation.ProgressPercent.PostProcessing, members.Count, members.Count) });

        var rep = results["rep"];
        var sampleInterval = settings.Simulation.WeatherSampleIntervalMinutes;
        // Same moisture series the native engine uses for the central run: Simard equilibrium + time lags + rain, sampled at the API's weather points.
        var representative = members[0].Weather;
        var moistureRows = DeadFuelMoisture.Series(representative, sampleInterval * 60, sc.DurationMinutes / sampleInterval + 1, settings.FuelMoisture, weather.SpinUpHours(wspec) * 60, wspec.FuelMoisture);
        double foliar = wspec.FuelMoisture?.Values?.FoliarPct ?? settings.NativeEngine.DefaultFoliarMoisturePct;
        return new FireRun
        {
            SimulationId = sim.Id, LocationId = sc.LocationId, Spec = spec, Start = sc.Start, DurationMinutes = sc.DurationMinutes, Ignition = rep.Ignition,
            Members = Enumerable.Range(0, members.Count - 1).Select(i => results[$"m{i}"].Ignition).ToArray(), IntensityKwm = rep.IntensityKwm, Flags = rep.Flags,
            Weather = Enumerable.Range(0, sc.DurationMinutes / sampleInterval + 1).Select(i =>
            {
                var p = track.At(i * sampleInterval);
                var row = moistureRows[i];
                return new WeatherSample { Time = sc.Start.AddMinutes(i * sampleInterval), Source = "scenario", WindKmh = Math.Round(p.WindKmh, 1), WindFromDeg = Math.Round(p.WindFromDeg), HumidityPct = Math.Round(p.HumidityPct), TempC = Math.Round(p.TempC, 1),
                    GustKmh = p.GustKmh > 0 ? Math.Round(p.GustKmh, 1) : null, PrecipitationMmH = p.PrecipitationMmH > 0 ? Math.Round(p.PrecipitationMmH, 1) : null, FineFuelMoisturePct = Math.Round(row.M1, 1),
                    FuelMoisture = new FuelMoisture(Math.Round(row.M1, 1), Math.Round(row.M10, 1), Math.Round(row.M100, 1), Math.Round(row.Lh, 1), Math.Round(row.Lw, 1), Math.Round(foliar, 1)) };
            }).ToList(),
            BuildingFactor = effect.BuildingFactor,
        };
    }

    /// <summary>A propagação de um membro: as estradas e rios travam mais ou menos conforme o vento mais forte que esse membro vê.</summary>
    float[] ApplyBarriers(BarrierSet barriers, float[] adjustment, WeatherTrack weather, int minutes, int seed)
    {
        double peakWind = Enumerable.Range(0, minutes / settings.Simulation.WeatherSampleIntervalMinutes + 1).Max(i => weather.At(i * settings.Simulation.WeatherSampleIntervalMinutes).WindKmh);
        return barriers.Apply(adjustment, peakWind, seed, settings.Landscape.MinAdjustmentFactor);
    }

    /// <summary>
    /// Grava o progresso das corridas do motor (uma de cada vez, para a ordem não se inverter), com o tempo restante estimado pelo ritmo até agora.
    /// Só grava enquanto a simulação está a correr, para nunca sobrepor o estado final.
    /// </summary>
    (Action<int, int> Report, Func<Task> Idle) Progress(string simulationId, int memberCount, CancellationToken ct)
    {
        var started = clock.GetUtcNow(); var gate = new object(); Task chain = Task.CompletedTask;
        void Report(int done, int total)
        {
            lock (gate) chain = chain.ContinueWith(async _ =>
            {
                if (await sims.GetAsync(simulationId, CancellationToken.None) is not { Status: SimulationStatus.Running } current) return;
                var p = settings.Simulation.ProgressPercent; double fraction = (double)done / Math.Max(total, 1), elapsed = (clock.GetUtcNow() - started).TotalSeconds;
                await Save(current with { Progress = new("running_members", Math.Round(p.RunningMembers + (p.PostProcessing - p.RunningMembers) * fraction, 1), Math.Min(memberCount, done * memberCount / Math.Max(total, 1)), memberCount,
                    done > 0 ? Math.Round(elapsed / done * (total - done)) : null) });
            }).Unwrap();
        }
        return (Report, () => { lock (gate) return chain; });
    }

    /// <summary>A ignição tem de cair em combustível: se cair em urbano, água ou rocha desloca-se para a célula inflamável mais próxima (até `snapRadius` células).</summary>
    IgnitionCell ToIgnitionCell(TerrainGrids g, Ignition i)
    {
        var spec = g.Spec;
        int snapRadius = settings.Simulation.IgnitionSnapRadiusCells;
        var (fx, fy) = spec.ToCell(i.Position.Lat, i.Position.Lon);
        int cx = (int)Math.Round(fx), cy = (int)Math.Round(fy);
        bool Flammable(int x, int y) => x >= 0 && y >= 0 && x < spec.Width && y < spec.Height && fuels.Get(g.LandCover[y * spec.Width + x]).Fbfm40 >= settings.Landscape.MinFlammableFuelModel;
        if (!Flammable(cx, cy))
        {
            var near = Enumerable.Range(-snapRadius, snapRadius * 2 + 1).SelectMany(dy => Enumerable.Range(-snapRadius, snapRadius * 2 + 1).Select(dx => (X: cx + dx, Y: cy + dy))).Where(c => Flammable(c.X, c.Y))
                .OrderBy(c => (c.X - cx) * (c.X - cx) + (c.Y - cy) * (c.Y - cy)).Cast<(int X, int Y)?>().FirstOrDefault()
                ?? throw new ValidationException($"A ignição cai numa zona sem combustível (urbano, água ou rocha) e não há combustível a menos de {snapRadius} células.", "/ignitions");
            (cx, cy) = near;
        }
        return new IgnitionCell(cx, cy, i.TimeOffsetMinutes * 60);
    }

    static SimulationStats Stats(FireRun run, TerrainGrids terrain)
    {
        double cellHa = FireAnalytics.CellHa(run.Spec), area = 0, crown = 0, buildings = 0; ushort maxI = 0;
        for (int i = 0; i < run.Ignition.Length; i++)
        {
            if (run.Ignition[i] < 0) continue;
            area += cellHa; if ((run.Flags[i] & 1) != 0) crown += cellHa;
            buildings += terrain.Buildings[i] * (run.BuildingFactor?[i] ?? 1f);
            maxI = Math.Max(maxI, run.IntensityKwm[i]);
        }
        return new SimulationStats(Math.Round(area, 1), Math.Round(crown, 1), maxI, (int)Math.Round(buildings));
    }

    async Task<Simulation> Save(Simulation s)
    {
        var saved = s with { UpdatedAt = clock.GetUtcNow() };
        await sims.UpsertAsync(saved);
        return saved;
    }
}
