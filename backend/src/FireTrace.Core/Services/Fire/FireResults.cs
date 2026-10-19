using System.Collections.Concurrent;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Models.Map;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Map;
using FireTrace.Core.Services.Routing;
using FireTrace.Core.Services.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Fire;

/// <summary>Tudo o que se deriva do resultado de uma simulação (marcos, perímetros, impacto, acessos, ameaças, fumo…). Funções sobre a grelha de minutos de ignição.</summary>
public sealed class FireResults(IFireRunRepository runs, IDocumentStore<Simulation> sims, IMapReader map, IDocumentStore<RoadClosure> closures, RoadCutsCache cutCache, FireTraceSettings settings, RoadSpeeds speeds, Population population)
{
    AnalyticsSettings Analytics => settings.Analytics;
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
    readonly ConcurrentDictionary<string, Lazy<Task<object>>> _memo = new();

    public async Task<FireRun> RunAsync(string simulationId, CancellationToken ct = default)
    {
        if (await runs.GetAsync(simulationId, ct) is { } run) return run;
        var sim = await sims.GetAsync(simulationId, ct) ?? throw new NotFoundException($"Simulação '{simulationId}'");
        throw new ConflictException($"A simulação está '{sim.Status}'; os resultados só existem quando terminar com sucesso.", "simulation_not_ready");
    }

    /// <summary>Guarda em memória resultados caros de calcular (acessos por minuto), por simulação.</summary>
    async Task<T> Memo<T>(string key, Func<Task<T>> compute) where T : notnull => (T)await _memo.GetOrAdd(key, _ => new(async () => await compute())).Value;

    int[] BurnMinutes(TerrainGrids t) => cutCache.BurnMinutes(t);

    RoadCuts CutsOf(FireRun run, RoadNetwork net, int[] burn, int[] ign, string key) => cutCache.Of(run, net, burn, ign, key);

    // ===================================================================================================== marcos
    public Task<SimulationSummary> SummaryAsync(string id, int step, string? percentile, CancellationToken ct = default) =>
        Memo($"summary:{id}:{step}:{percentile}", async () =>
        {
            var run = await RunAsync(id, ct);
            var terrain = await map.GetTerrainAsync(run.LocationId, ct);
            var net = await map.GetRoadsAsync(run.LocationId, ct);
            var places = await map.GetPlacesAsync(run.LocationId, ct);
            var ign = run.Pick(percentile);
            var burn = BurnMinutes(terrain);
            var cuts = CutsOf(run, net, burn, ign, percentile ?? "rep");
            var placeCells = places.Select(p => (Place: p, Cell: run.Spec.CellAt(p.Lat, p.Lon))).Where(x => x.Cell >= 0).ToList();
            double cellHa = FireAnalytics.CellHa(run.Spec);
            var rows = new List<SummaryMilestone>();
            var origin = FireAnalytics.Origin(ign, run.Spec);
            for (int t = 0; t <= run.DurationMinutes; t += Math.Clamp(step, 1, settings.Limits.MaxStepMinutes))
            {
                var vectors = FireAnalytics.Vectors(ign, run.Spec, t, Analytics, settings.Defaults.VectorWindowMinutes);
                var head = FireAnalytics.Head(vectors, Analytics, origin);
                double area = 0, crown = 0, buildings = 0, maxI = 0;
                for (int i = 0; i < ign.Length; i++)
                {
                    if (ign[i] < 0 || ign[i] > t) continue;
                    area += cellHa;
                    if ((run.Flags[i] & 1) != 0) crown += cellHa;
                    buildings += terrain.Buildings[i] * (run.BuildingFactor?[i] ?? 1f);
                    if (t - ign[i] < Analytics.IntensityWindowMinutes) maxI = Math.Max(maxI, run.IntensityKwm[i]);
                }
                var w = run.WeatherAt(t);
                rows.Add(new SummaryMilestone(t, run.Start.AddMinutes(t), Math.Round(area, 1), rows.Count == 0 ? null : Math.Round((area - rows[^1].AreaHa) / Math.Max(1, t - rows[^1].TMin) * 60, 1),
                    head?.SpeedMPerMin, head?.BearingDeg, maxI, Math.Round(crown, 1), (int)Math.Round(buildings), Enumerable.Range(0, net.Edges.Count).Count(e => cuts.IsCut(e, t)),
                    placeCells.Count(x => ign[x.Cell] is var v && v >= 0 && v <= t), head?.Position,
                    new WeatherCore { WindKmh = w.WindKmh, WindFromDeg = w.WindFromDeg, HumidityPct = w.HumidityPct, TempC = w.TempC }));
            }
            return new SimulationSummary(id, rows, rows.LastOrDefault());
        });

    // ===================================================================================================== perímetros e vetores
    public async Task<FeatureCollection<Feature<PerimeterProperties>>> PerimetersAsync(string id, int? tMin, int? step, ISet<string> percentiles, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        var times = step is { } s ? Enumerable.Range(0, run.DurationMinutes / Math.Max(1, s) + 1).Select(i => i * s).ToList() : new List<int> { Math.Clamp(tMin ?? run.DurationMinutes, 0, run.DurationMinutes) };
        var picks = percentiles.Count == 0 ? new[] { "p50" } : percentiles.ToArray();
        var features = new List<Feature<PerimeterProperties>>();
        foreach (var p in picks)
            foreach (var t in times)
            {
                var ign = run.Pick(p);
                features.Add(new(FireAnalytics.Perimeter(ign, run.Spec, t, Analytics), new PerimeterProperties(t, run.Start.AddMinutes(t), Math.Round(FireAnalytics.AreaHa(ign, run.Spec, t), 1), p)));
            }
        return new FeatureCollection<Feature<PerimeterProperties>>(features);
    }

    public async Task<FeatureCollection<Feature<SpreadVectorProperties>>> VectorsAsync(string id, int tMin, int windowMin, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        var features = FireAnalytics.Vectors(run.Ignition, run.Spec, tMin, Analytics, Math.Max(1, windowMin)).Select(v =>
        {
            int cell = run.Spec.CellAt(v.Lat, v.Lon);
            return new Feature<SpreadVectorProperties>(Gf.CreatePoint(new Coordinate(v.Lon, v.Lat)),
                new SpreadVectorProperties(tMin, Math.Round(v.BearingDeg), Math.Round(v.SpeedMPerMin, 1), cell >= 0 ? run.IntensityKwm[cell] : null, cell >= 0 && (run.Flags[cell] & 1) != 0));
        }).ToList();
        return new FeatureCollection<Feature<SpreadVectorProperties>>(features);
    }

    // ===================================================================================================== grelhas e meteorologia
    public async Task<(byte[] Bytes, int Width, int Height, double CellM, string DType)> GridAsync(string id, string grid, string? member, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        byte[] bytes; string dtype;
        switch (grid)
        {
            case "ignition":
                var ign = member is { } m && m.StartsWith('m') && int.TryParse(m[1..], out var k) && k < run.Members.Length ? run.Members[k] : run.Ignition;
                bytes = new byte[ign.Length * 2];
                for (int i = 0; i < ign.Length; i++) BitConverter.TryWriteBytes(bytes.AsSpan(i * 2), (short)ign[i]);
                dtype = "int16"; break;
            case "intensity": bytes = new byte[run.IntensityKwm.Length * 2]; Buffer.BlockCopy(run.IntensityKwm, 0, bytes, 0, bytes.Length); dtype = "uint16"; break;
            case "flags": bytes = run.Flags; dtype = "uint8"; break;
            default: throw new ValidationException($"Grelha desconhecida '{grid}'.", "/grid");
        }
        return (bytes, run.Spec.Width, run.Spec.Height, run.Spec.CellM, dtype);
    }

    public async Task<WeatherSeries> WeatherAsync(string id, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        return new WeatherSeries(run.LocationId, run.Weather, run.Start, run.Start.AddMinutes(run.DurationMinutes), settings.Simulation.WeatherSampleIntervalMinutes, new List<string> { "Meteorologia usada pelo motor" });
    }

    // ===================================================================================================== impacto, estradas e acessos
    public async Task<RoadStatusTimeline> RoadStatusAsync(string id, ISet<string> classes, double minProbability, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        var net = await map.GetRoadsAsync(run.LocationId, ct);
        var burn = BurnMinutes(await map.GetTerrainAsync(run.LocationId, ct));
        var members = run.Ensemble.Select((ign, i) => CutsOf(run, net, burn, ign, run.Members.Length == 0 ? "rep" : $"m{i}")).ToList();
        var rep = CutsOf(run, net, burn, run.Ignition, "rep");
        var roads = new List<RoadStatusEntry>();
        for (int i = 0; i < net.Edges.Count; i++)
        {
            var e = net.Edges[i];
            if (e.OffRoad || (classes.Count > 0 && !classes.Contains(e.Highway))) continue;
            var cutting = members.Where(m => m.From[i] >= 0).ToList();
            double p = (double)cutting.Count / members.Count;
            if (p < minProbability && rep.From[i] < 0) continue;
            roads.Add(new RoadStatusEntry(MapIds.Road(e.Id), e.Highway, e.Name, FireAnalytics.Quantiles(cutting.Select(m => (double)m.From[i]).ToList()),
                FireAnalytics.Quantiles(cutting.Select(m => (double)m.Until[i]).ToList()), Math.Round(p, 2), await ActiveClosure(run.LocationId, e.Id, ct)));
        }
        return new RoadStatusTimeline(id, run.DurationMinutes, roads);
    }

    async Task<string?> ActiveClosure(string loc, int edgeId, CancellationToken ct) =>
        (await closures.ListAsync(ct)).FirstOrDefault(c => c.LocationId == loc && c.Status == ClosureStatus.Active && c.RoadIds?.Contains(MapIds.Road(edgeId)) == true)?.Id;

    /// <summary>Origens de socorro (instalações) por tipo de meio: `fire_brigade`, `gnr`, `inem` (inclui hospitais) ou `any`.</summary>
    public async Task<IReadOnlyList<Facility>> OriginsAsync(string loc, string origin, CancellationToken ct = default) =>
        (await map.GetFacilitiesAsync(loc, ct)).Where(f => origin switch
        {
            "gnr" => f.Kind is FacilityKind.Gnr, "inem" => f.Kind is FacilityKind.Inem or FacilityKind.Hospital,
            "any" => f.Kind is FacilityKind.FireStation or FacilityKind.Gnr or FacilityKind.Psp or FacilityKind.Inem or FacilityKind.Hospital or FacilityKind.CivilProtection,
            _ => f.Kind == FacilityKind.FireStation,
        }).ToList();

    public Task<PlaceAccessTimeline> PlaceAccessAsync(string id, string origin, int stepMin, string? percentile, CancellationToken ct = default) =>
        Memo($"access:{id}:{origin}:{stepMin}:{percentile}", async () =>
        {
            var run = await RunAsync(id, ct);
            var net = await map.GetRoadsAsync(run.LocationId, ct);
            var graph = RoadGraph.For(net);
            var places = await map.GetPlacesAsync(run.LocationId, ct);
            var burn = BurnMinutes(await map.GetTerrainAsync(run.LocationId, ct));
            Anchor A(string key, double lat, double lon) { var (x, y) = net.Spec.ToCell(lat, lon); return new Anchor(key, x, y); }
            var origins = (await OriginsAsync(run.LocationId, origin, ct)).Select(f => A(f.Name, f.Lat, f.Lon)).ToList();
            var targets = places.Select(p => A(p.Name, p.Lat, p.Lon)).ToList();
            var profile = speeds.Profile(emergency: false);
            var baseline = graph.AccessTimes(origins, targets, profile);
            var rep = CutsOf(run, net, burn, run.Pick(percentile), percentile ?? "rep");
            var members = run.Members.Select((m, i) => CutsOf(run, net, burn, m, $"m{i}")).ToList();
            var memo = new ConcurrentDictionary<string, double?[]>();
            double?[] Access(RoadCuts c, int t) => memo.GetOrAdd(string.Join(',', Enumerable.Range(0, net.Edges.Count).Where(e => c.IsCut(e, t))), _ => graph.AccessTimes(origins, targets, profile, e => c.IsCut(e, t)));

            var times = Enumerable.Range(0, run.DurationMinutes / Math.Max(1, stepMin) + 1).Select(i => i * stepMin).ToList();
            var minutes = places.Select(_ => new List<double?>()).ToArray(); var iso = places.Select(_ => new List<double>()).ToArray(); var status = places.Select(_ => new List<string>()).ToArray();
            foreach (var t in times)
            {
                var acc = Access(rep, t);
                var memberAcc = members.Select(m => Access(m, t)).ToList();
                for (int p = 0; p < places.Count; p++)
                {
                    minutes[p].Add(acc[p]);
                    iso[p].Add(memberAcc.Count == 0 ? 0 : Math.Round((double)memberAcc.Count(a => a[p] is null) / memberAcc.Count, 2));
                    status[p].Add(acc[p] is null ? "cut" : baseline[p] is { } b && acc[p] > b * Analytics.SlowAccessFactor + Analytics.SlowAccessExtraMinutes ? "slow" : "ok");
                }
            }
            return new PlaceAccessTimeline(id, origin, stepMin, times, places.Select((p, i) => new PlaceAccess(MapIds.Place(p.Id), p.Name, p.Population, minutes[i], iso[i], status[i])).ToList());
        });

    public async Task<ImpactReport> ImpactAsync(string id, int tMin, string? percentile, bool includeOpen, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        var terrain = await map.GetTerrainAsync(run.LocationId, ct);
        var net = await map.GetRoadsAsync(run.LocationId, ct);
        var burn = BurnMinutes(terrain);
        var ign = run.Pick(percentile);
        var cuts = CutsOf(run, net, burn, ign, percentile ?? "rep");
        var memberCuts = run.Ensemble.Select((m, i) => CutsOf(run, net, burn, m, run.Members.Length == 0 ? "rep" : $"m{i}")).ToList();

        var roads = new List<RoadImpact>();
        for (int e = 0; e < net.Edges.Count; e++)
        {
            var edge = net.Edges[e];
            if (edge.OffRoad) continue;
            var cutting = memberCuts.Where(m => m.IsCut(e, tMin)).ToList();
            bool cut = cuts.IsCut(e, tMin);
            double p = (double)cutting.Count / memberCuts.Count;
            if (!includeOpen && !cut && p == 0) continue;
            roads.Add(new RoadImpact(MapIds.Road(edge.Id), edge.Name, edge.Ref == "" ? null : edge.Ref, edge.Highway, cut ? "cut" : p > 0 ? "at_risk" : "open", Math.Round(p, 2),
                FireAnalytics.Quantiles(memberCuts.Where(m => m.From[e] >= 0).Select(m => (double)m.From[e]).ToList()), Math.Round(edge.LengthCells * net.Spec.CellM)));
        }

        var places = await map.GetPlacesAsync(run.LocationId, ct);
        string origin = settings.Defaults.PlaceAccessOrigin; int accessStep = settings.Defaults.PlaceAccessStepMinutes;
        var access = (await PlaceAccessAsync(id, origin, accessStep, percentile, ct)).Places;
        int accessIndex = Math.Min(tMin / accessStep, access.FirstOrDefault()?.AccessMinutes.Count - 1 ?? 0);
        var placeImpacts = places.Select((p, i) =>
        {
            int cell = run.Spec.CellAt(p.Lat, p.Lon);
            var arrivals = cell < 0 ? new List<double>() : run.Ensemble.Where(m => m[cell] >= 0).Select(m => (double)m[cell]).ToList();
            bool burning = cell >= 0 && ign[cell] >= 0 && ign[cell] <= tMin && tMin - ign[cell] < burn[cell];
            var a = access.Count > i && accessIndex >= 0 ? access[i] : null;
            bool isolated = a is not null && a.AccessMinutes[accessIndex] is null;
            double arrivalP = run.Ensemble.Count == 0 ? 0 : (double)arrivals.Count / run.Ensemble.Count;
            string st = burning ? "burning" : isolated ? "isolated" : arrivalP > Analytics.AtRiskProbability ? "at_risk" : "safe";
            return new PlaceImpact(MapIds.Place(p.Id), p.Name, p.Population, st, Math.Round(arrivalP, 2), FireAnalytics.Quantiles(arrivals),
                new BestAccess(null, origin, a?.AccessMinutes[accessIndex], a is not null && !isolated));
        }).ToList();

        var facilities = (await map.GetFacilitiesAsync(run.LocationId, ct)).Select(f =>
        {
            int cell = run.Spec.CellAt(f.Lat, f.Lon);
            double p = cell < 0 || run.Ensemble.Count == 0 ? 0 : (double)run.Ensemble.Count(m => m[cell] >= 0 && m[cell] <= tMin) / run.Ensemble.Count;
            return new FacilityImpact(MapIds.Facility(f.Id), f.Name, EnumText.ToSnake(f.Kind), cell >= 0 && ign[cell] >= 0 && ign[cell] <= tMin ? "burning" : p > Analytics.AtRiskProbability ? "at_risk" : "safe", Math.Round(p, 2));
        }).Where(f => f.Status != "safe").ToList();

        var buildingSamples = run.Ensemble.Select(m => Enumerable.Range(0, m.Length).Where(i => m[i] >= 0 && m[i] <= tMin).Sum(i => terrain.Buildings[i] * (run.BuildingFactor?[i] ?? 1f))).Select(v => (double)v).ToList();
        int exposed = population.Of((int)Enumerable.Range(0, ign.Length).Where(i => ign[i] >= 0 && ign[i] <= tMin).Sum(i => terrain.Buildings[i]));
        return new ImpactReport(id, tMin, run.Start.AddMinutes(tMin), run.Members.Length, percentile ?? "p50", Math.Round(FireAnalytics.AreaHa(ign, run.Spec, tMin), 1),
            FireAnalytics.Quantiles(buildingSamples), exposed, roads, placeImpacts, facilities);
    }

    // ===================================================================================================== chegada e ameaças
    public async Task<ArrivalEntry> ArrivalOfAsync(FireRun run, ArrivalPoint p, CancellationToken ct = default)
    {
        int cell = run.Spec.CellAt(p.Position.Lat, p.Position.Lon);
        if (cell < 0) return new ArrivalEntry(p.Id, p.Position, false, 0, null, null, null, false);
        var arrivals = run.Ensemble.Where(m => m[cell] >= 0).Select(m => (double)m[cell]).ToList();
        double prob = (double)arrivals.Count / run.Ensemble.Count;
        var q = FireAnalytics.Quantiles(arrivals);
        return new ArrivalEntry(p.Id, p.Position, prob >= 0.5, Math.Round(prob, 2), arrivals.Count == 0 ? null : q, q.P50 is { } m50 ? run.Start.AddMinutes(m50) : null,
            run.Ignition[cell] >= 0 ? run.IntensityKwm[cell] : null, run.Ignition[cell] >= 0 && (run.Flags[cell] & 1) != 0);
    }

    public async Task<ArrivalResult> ArrivalAsync(string id, IEnumerable<ArrivalPoint> points, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        var items = new List<ArrivalEntry>();
        foreach (var p in points) items.Add(await ArrivalOfAsync(run, p, ct));
        return new ArrivalResult(id, items);
    }

    public async Task<ThreatenedReport> ThreatenedAsync(string id, int? tMin, int horizonMin, double minProbability, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        int t0 = Math.Clamp(tMin ?? run.DurationMinutes, 0, run.DurationMinutes), t1 = t0 + horizonMin;
        var terrain = await map.GetTerrainAsync(run.LocationId, ct);
        var net = await map.GetRoadsAsync(run.LocationId, ct);
        var burn = BurnMinutes(terrain);
        var assets = new List<ThreatenedAsset>();

        ThreatenedAsset? Asset(string type, string aid, string? name, double lat, double lon, bool vulnerable = false, int? population = null)
        {
            int cell = run.Spec.CellAt(lat, lon);
            if (cell < 0) return null;
            var arr = run.Ensemble.Where(m => m[cell] >= 0 && m[cell] <= t1).Select(m => (double)m[cell]).ToList();
            double p = (double)arr.Count / run.Ensemble.Count;
            return p < minProbability ? null : new ThreatenedAsset(type, aid, name, new LatLon(lat, lon), Math.Round(p, 2), FireAnalytics.Quantiles(arr), vulnerable, population);
        }
        assets.AddRange((await map.GetPlacesAsync(run.LocationId, ct)).Select(p => Asset("place", MapIds.Place(p.Id), p.Name, p.Lat, p.Lon, population: p.Population)).OfType<ThreatenedAsset>());
        assets.AddRange((await map.GetFacilitiesAsync(run.LocationId, ct)).Select(f => Asset("facility", MapIds.Facility(f.Id), f.Name, f.Lat, f.Lon, f.Vulnerable, f.Capacity)).OfType<ThreatenedAsset>());
        assets.AddRange((await map.GetWaterPointsAsync(run.LocationId, ct)).Where(w => w.Kind != WaterPointKind.SwimmingPool).Select(w => Asset("water_point", MapIds.Water(w.Id), w.Name, w.Lat, w.Lon)).OfType<ThreatenedAsset>());

        var memberCuts = run.Ensemble.Select((m, i) => CutsOf(run, net, burn, m, run.Members.Length == 0 ? "rep" : $"m{i}")).ToList();
        for (int e = 0; e < net.Edges.Count; e++)
        {
            if (net.Edges[e].OffRoad) continue;
            var cutting = memberCuts.Where(m => m.From[e] >= 0 && m.From[e] <= t1 && m.Until[e] > t0).ToList();
            double p = (double)cutting.Count / memberCuts.Count;
            if (p >= minProbability) assets.Add(new ThreatenedAsset("road", MapIds.Road(net.Edges[e].Id), net.Edges[e].Name, null, Math.Round(p, 2), FireAnalytics.Quantiles(cutting.Select(m => (double)m.From[e]).ToList())));
        }

        var ign = run.Ignition;
        int bCount = 0;
        for (int i = 0; i < ign.Length; i++)
            if (terrain.Buildings[i] > 0 && run.Ensemble.Count(m => m[i] >= 0 && m[i] > t0 && m[i] <= t1) / (double)run.Ensemble.Count >= minProbability) bCount += terrain.Buildings[i];
        return new ThreatenedReport(id, t0, horizonMin, minProbability, assets.OrderBy(a => a.ArrivalMinute.P50 ?? double.MaxValue).ToList(), new ThreatenedBuildings(bCount, population.Of(bCount)));
    }

    public async Task<Smoke> SmokeAsync(string id, int tMin, CancellationToken ct = default)
    {
        var run = await RunAsync(id, ct);
        var terrain = await map.GetTerrainAsync(run.LocationId, ct);
        var net = await map.GetRoadsAsync(run.LocationId, ct);
        var spec = run.Spec; var ign = run.Ignition;
        var smoke = settings.Smoke; var burn = BurnMinutes(terrain);
        int block = smoke.BlockCells;
        var groups = new Dictionary<(int, int), List<int>>();
        for (int i = 0; i < ign.Length; i++)
        {
            if (ign[i] < 0 || ign[i] > tMin || tMin - ign[i] >= burn[i]) continue;
            int x = i % spec.Width, y = i / spec.Width;
            if (!groups.TryGetValue((x / block, y / block), out var l)) groups[(x / block, y / block)] = l = new();
            l.Add(i);
        }
        var sources = groups.Values.Select(cells =>
        {
            double intensity = cells.Max(c => (double)run.IntensityKwm[c]);
            bool crown = cells.Any(c => (run.Flags[c] & 1) != 0);
            var (lat, lon) = spec.ToLatLon(cells.Average(c => c % spec.Width), cells.Average(c => c / spec.Width));
            double height = smoke.PlumeBaseHeightM + smoke.PlumeHeightPerSqrtKwm * Math.Sqrt(Math.Max(intensity, 0) / smoke.PlumeReferenceKwm) * (crown ? smoke.CrownHeightFactor : 1); // altura da coluna a partir da intensidade da linha de fogo
            return new Feature<SmokeSourceProperties>(Gf.CreatePoint(new Coordinate(Math.Round(lon, 6), Math.Round(lat, 6))), new SmokeSourceProperties(Math.Round(intensity), Math.Round(height), crown));
        }).ToList();
        var w = run.WeatherAt(tMin);
        double drift = (w.WindFromDeg!.Value + 180) % 360, speed = w.WindKmh ?? 0;
        var heights = sources.Select(s => s.Properties.ColumnHeightM).OrderBy(h => h).ToList();

        Geometry? corridor = null;
        if (sources.Count > 0)
        {
            var cx = sources.Average(s => s.Geometry.Coordinate.X); var cy = sources.Average(s => s.Geometry.Coordinate.Y);
            double km = Math.Clamp(speed * smoke.DriftHours, smoke.MinDriftKm, smoke.MaxDriftKm), rad = drift * Math.PI / 180;
            double dLat = km * 1000 / Zones.MetersPerDegree * Math.Cos(rad), dLon = km * 1000 / (Zones.MetersPerDegree * Math.Cos(cy * Math.PI / 180)) * Math.Sin(rad);
            corridor = Gf.CreateLineString(new[] { new Coordinate(cx, cy), new Coordinate(cx + dLon, cy + dLat) }).Buffer(smoke.CorridorWidthM / Zones.MetersPerDegree);
        }
        return new Smoke(id, tMin, Math.Round(speed, 1), Math.Round(w.WindFromDeg.Value), Math.Round(drift), Math.Round(speed * smoke.DriftSpeedFactor, 1),
            new PlumeHeight(heights.Count == 0 ? 0 : heights[heights.Count / 2], heights.Count == 0 ? 0 : heights[^1]), new FeatureCollection<Feature<SmokeSourceProperties>>(sources), corridor, Array.Empty<string>()); // as estradas afetadas preenche-as o SmokeService, pela visibilidade
    }
}
