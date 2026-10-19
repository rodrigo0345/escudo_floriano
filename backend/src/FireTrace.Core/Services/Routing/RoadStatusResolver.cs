using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Map;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

/// <summary>
/// Estado de cada troço num instante: `closed` se há um corte ativo, `burned`/`at_risk` se a simulação pedida prevê fogo nele
/// (`burned` enquanto arde, `at_risk` nos minutos anteriores de `FireTrace:Routing:RoadStatusWarningMinutes`) e `open` nos restantes casos.
/// </summary>
public sealed class RoadStatusResolver(IDocumentStore<RoadClosure> closures, IFireRunRepository runs, RoadCutsCache cutsCache, RoutingSettings routing)
{

    public async Task<Func<RoadEdge, (string Status, string? ClosureId)>> ForAsync(string locationId, DateTimeOffset at, string? simulationId, string percentile, CancellationToken ct = default)
    {
        var active = (await closures.ListAsync(ct)).Where(c => c.LocationId == locationId && c.Status == ClosureStatus.Active && c.Start <= at && (c.End is null || c.End > at))
            .SelectMany(c => (c.RoadIds ?? new()).Select(id => (Id: MapIds.RoadNumber(id), Closure: c.Id))).Where(x => x.Id is not null)
            .GroupBy(x => x.Id!.Value).ToDictionary(g => g.Key, g => g.First().Closure);

        Func<RoadEdge, string> fire = _ => "open";
        if (simulationId is not null && await runs.GetAsync(simulationId, ct) is { } run)
        {
            var (net, cuts) = await cutsCache.ForPercentileAsync(run, percentile, ct: ct);
            var index = net.Edges.Select((e, i) => (e.Id, i)).ToDictionary(x => x.Id, x => x.i);
            double minute = (at - run.Start).TotalMinutes;
            fire = edge =>
            {
                int i = index[edge.Id];
                if (cuts.From[i] < 0) return "open";
                return cuts.IsCut(i, (int)minute) ? "burned" : minute < cuts.From[i] && minute >= cuts.From[i] - routing.RoadStatusWarningMinutes ? "at_risk" : "open";
            };
        }
        return edge => active.TryGetValue(edge.Id, out var closure) ? ("closed", closure) : (fire(edge), null);
    }
}
