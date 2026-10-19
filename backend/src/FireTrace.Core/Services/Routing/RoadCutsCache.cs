using System.Collections.Concurrent;
using FireTrace.Core.Domain.Fire;
using FireTrace.Core.Domain.Fuel;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Routing;

/// <summary>Os cortes de estrada previstos por uma simulação, calculados uma só vez por corrida e percentil (resultados, rotas e estado das estradas usam-nos).</summary>
public sealed class RoadCutsCache(IMapReader map, FuelCatalog fuels)
{
    readonly ConcurrentDictionary<string, RoadCuts> _cache = new();

    /// <summary>Quanto tempo arde cada célula (pela sua vegetação): um troço fica cortado enquanto há fogo perto.</summary>
    public int[] BurnMinutes(TerrainGrids t) => t.LandCover.Select(c => fuels.Get(c).BurnMinutes).ToArray();

    /// <summary>Cortes de uma corrida concreta (`key` identifica-a: um percentil ou um membro do ensemble).</summary>
    public RoadCuts Of(FireRun run, RoadNetwork net, int[] burn, int[] ignition, string key, int radiusCells = 1) =>
        _cache.GetOrAdd($"{run.SimulationId}:{key}:{radiusCells}", _ => RoadCuts.Compute(net, ignition, burn, radiusCells));

    /// <param name="clearanceM">Folga ao fogo, em metros (os percursos mantêm-se a pelo menos isto do fogo previsto); sem ela só contam as células vizinhas.</param>
    public async Task<(RoadNetwork Net, RoadCuts Cuts)> ForPercentileAsync(FireRun run, string? percentile, double? clearanceM = null, CancellationToken ct = default)
    {
        var net = await map.GetRoadsAsync(run.LocationId, ct);
        var burn = BurnMinutes(await map.GetTerrainAsync(run.LocationId, ct));
        int radius = clearanceM is { } m ? Math.Max(1, (int)Math.Ceiling(m / net.Spec.CellM)) : 1;
        return (net, Of(run, net, burn, run.Pick(percentile), percentile ?? "rep", radius));
    }
}
