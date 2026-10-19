using System.Collections.Concurrent;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Services.Map;
using FireTrace.Core.Services.Routing;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Fire;

/// <summary>Consultas ao fumo de uma simulação: o campo para o mapa e a visibilidade em pontos e estradas (para os planos não mandarem ninguém para onde não se vê).</summary>
public sealed class SmokeService(FireResults results, IMapReader map, RoadCutsCache cuts, SmokePlume plume, Rules rules, FireTraceSettings settings)
{
    SmokeDispersionSettings D => settings.Smoke.Dispersion;
    readonly ConcurrentDictionary<string, WindDisplacement> _winds = new();

    /// <summary>Tudo o que se calcula do fumo de uma corrida, uma vez: o terreno (para o tempo de queima), o vento e a duração.</summary>
    sealed record Context(FireRun Run, int[] Burn, WindDisplacement Wind);

    async Task<Context> ContextAsync(string id, CancellationToken ct)
    {
        var run = await results.RunAsync(id, ct);
        var burn = cuts.BurnMinutes(await map.GetTerrainAsync(run.LocationId, ct));
        return new(run, burn, _winds.GetOrAdd(id, _ => new WindDisplacement(run, run.DurationMinutes + D.PuffLifetimeMinutes + 2)));
    }

    /// <summary>O fumo continua a dispersar-se depois de o fogo acabar: consulta-se até `PuffLifetimeMinutes` além da duração da simulação.</summary>
    int Clamp(Context c, int minute) => Math.Clamp(minute, 0, c.Run.DurationMinutes + D.PuffLifetimeMinutes);

    SmokeSample Sample(Context c, int tMin, IReadOnlyList<SmokePuff> puffs, IEnumerable<(double X, double Y)> places)
    {
        string stability = plume.Stability(c.Run, c.Wind.SpeedMs(tMin), tMin);
        double concentration = places.Max(p => plume.GroundConcentration(puffs, stability, p.X, p.Y));
        var v = plume.Visibility(concentration);
        return new(tMin, Math.Round(concentration, 1), Math.Round(v.VisibilityM), v.Class, v.VisibilityM >= rules.Safety.MinGroundVisibilityM, v.VisibilityM >= rules.Aerial.Limits.MinVisibilityM);
    }

    // ===================================================================================================== pontos e estradas
    public async Task<SmokeQueryResult> QueryAsync(string id, SmokeQuery q, CancellationToken ct = default)
    {
        if (q.Points is not { Count: > 0 }) throw new ValidationException("Indique pelo menos um ponto.", "/points");
        if (q.Points.Count > D.MaxQueryPoints) throw new ValidationException($"No máximo {D.MaxQueryPoints} pontos por pedido.", "/points");
        var c = await ContextAsync(id, ct);
        var places = new List<(SmokePointRef Ref, List<(double X, double Y)> Spots)>();
        RoadNetwork? net = null;
        foreach (var (p, i) in q.Points.Select((p, i) => (p, i)))
            if (p.RoadId is { } roadId)
            {
                net ??= await map.GetRoadsAsync(c.Run.LocationId, ct);
                var edge = net.Edges.FirstOrDefault(e => MapIds.RoadNumber(roadId) == e.Id) ?? throw new ValidationException($"Troço '{roadId}' desconhecido.", $"/points/{i}/roadId");
                places.Add((p, RoadSpots(edge, c.Run.Spec)));
            }
            else if (p.Position is { } at)
            {
                var (cx, cy) = c.Run.Spec.ToCell(at.Lat, at.Lon);
                places.Add((p, new() { ((cx + 0.5) * c.Run.Spec.CellM, (cy + 0.5) * c.Run.Spec.CellM) }));
            }
            else throw new ValidationException("Cada ponto precisa de `position` ou de `roadId`.", $"/points/{i}");

        int from = Clamp(c, q.FromMin ?? 0), to = Clamp(c, q.ToMin ?? from), step = Math.Max(1, q.StepMin ?? D.QueryDefaultStepMinutes);
        var minutes = Enumerable.Range(0, (to - from) / step + 1).Select(k => from + k * step).ToList();
        if (minutes[^1] != to && to > from) minutes.Add(to);
        var samples = places.Select(_ => new List<SmokeSample>()).ToList();
        foreach (int t in minutes)
        {
            var puffs = plume.Puffs(c.Run, c.Burn, c.Wind, t);
            for (int k = 0; k < places.Count; k++) samples[k].Add(Sample(c, t, puffs, places[k].Spots));
        }
        var items = places.Select((p, k) => Series(p.Ref, samples[k])).ToList();
        return new(id, rules.Safety.MinGroundVisibilityM, rules.Aerial.Limits.MinVisibilityM, items);
    }

    /// <summary>Pontos ao longo de um troço (amostrados de forma regular) onde se mede o fumo; o troço vale pelo seu pior ponto.</summary>
    List<(double X, double Y)> RoadSpots(RoadEdge edge, GridSpec spec)
    {
        int n = edge.Pts.Length / 2, count = Math.Min(D.RoadSamplePoints, n);
        return Enumerable.Range(0, count).Select(k => n == 1 ? 0 : (int)Math.Round(k * (n - 1.0) / Math.Max(count - 1, 1)))
            .Select(i => ((edge.Pts[2 * i] + 0.5) * spec.CellM, (edge.Pts[2 * i + 1] + 0.5) * spec.CellM)).ToList();
    }

    public static SmokeSeries Series(SmokePointRef p, IReadOnlyList<SmokeSample> samples)
    {
        int lastUnsafe = samples.ToList().FindLastIndex(s => !s.SafeForGroundOperations);
        int? unsafeFrom = samples.FirstOrDefault(s => !s.SafeForGroundOperations)?.TMin;
        int? safeAgain = lastUnsafe >= 0 && lastUnsafe < samples.Count - 1 ? samples[lastUnsafe + 1].TMin : null;
        return new(p.Id, p.Position, p.RoadId, samples.Min(s => s.VisibilityM), samples[0].SafeForGroundOperations, unsafeFrom, safeAgain, samples);
    }

    // ===================================================================================================== resumo (para o mapa e os planos)
    /// <summary>O `/smoke` clássico (fontes, altura, deriva), com as estradas afetadas medidas pela visibilidade do campo e não por um corredor reto.</summary>
    public async Task<Smoke> SummaryAsync(string id, int tMin, CancellationToken ct = default)
    {
        var summary = await results.SmokeAsync(id, tMin, ct);
        var c = await ContextAsync(id, ct);
        var net = await map.GetRoadsAsync(c.Run.LocationId, ct);
        var puffs = plume.Puffs(c.Run, c.Burn, c.Wind, Clamp(c, tMin)); string stability = plume.Stability(c.Run, c.Wind.SpeedMs(tMin), tMin);
        var spec = c.Run.Spec;
        int cols = (int)Math.Ceiling(spec.Width * spec.CellM / D.FieldBlockM), rows = (int)Math.Ceiling(spec.Height * spec.CellM / D.FieldBlockM);
        var concentration = plume.Field(puffs, stability, cols, rows, D.FieldBlockM); // uma vez para o mapa todo: medir cada troço contra todas as nuvens seria lento
        bool InSmoke((double X, double Y) s) => plume.Visibility(concentration[Math.Clamp((int)(s.Y / D.FieldBlockM), 0, rows - 1) * cols + Math.Clamp((int)(s.X / D.FieldBlockM), 0, cols - 1)]).VisibilityM < rules.Safety.MinGroundVisibilityM;
        var affected = net.Edges.Where(e => !e.OffRoad).Where(e => RoadSpots(e, c.Run.Spec).Any(InSmoke))
            .Take(settings.Smoke.MaxAffectedRoads).Select(e => MapIds.Road(e.Id)).ToList();
        return summary with { AffectedRoadIds = affected };
    }
}
