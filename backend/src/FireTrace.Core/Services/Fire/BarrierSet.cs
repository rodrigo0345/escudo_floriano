using FireTrace.Core.Configuration;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Fire;

/// <summary>
/// Estradas e cursos de água como barreiras ao fogo. Uma via larga ou um rio travam quase por completo, mas não sempre: com vento forte as faíscas
/// e as chamas galgam-nas em manchas. A localização das barreiras é fixa; quais as manchas galgadas depende do vento e da semente de cada membro
/// do ensemble (sempre as mesmas para os mesmos valores).
/// </summary>
public sealed class BarrierSet
{
    readonly int[] _cells;
    readonly BarrierClass[] _classes;
    readonly int _width;
    readonly BarrierSettings _settings;

    BarrierSet(Dictionary<int, BarrierClass> strongest, int width, BarrierSettings settings)
    {
        _cells = strongest.Keys.ToArray();
        _classes = _cells.Select(c => strongest[c]).ToArray();
        _width = width; _settings = settings;
    }

    public int Count => _cells.Length;

    /// <summary>Junta as vias e os cursos de água do local; numa célula com várias barreiras vale a mais restritiva.</summary>
    public static BarrierSet Build(GridSpec spec, RoadNetwork roads, IEnumerable<Waterway> waterways, BarrierSettings settings)
    {
        var strongest = new Dictionary<int, BarrierClass>();
        void Add(IEnumerable<int> cells, BarrierClass? barrier)
        {
            if (barrier is null) return;
            foreach (int c in cells)
                if (!strongest.TryGetValue(c, out var current) || barrier.BlockFactor < current.BlockFactor) strongest[c] = barrier;
        }
        foreach (var r in roads.Edges.Where(r => !r.OffRoad)) // caminhos de terra não travam o fogo como uma estrada
            Add(r.CellIdx, settings.Roads.GetValueOrDefault(r.Highway));
        foreach (var w in waterways)
            Add(Zones.Connected(Zones.CellsOf(spec, w.Geometry, 0), spec.Width), settings.Waterways.GetValueOrDefault(EnumText.ToSnake(w.Kind)));
        return new BarrierSet(strongest, spec.Width, settings);
    }

    /// <summary>
    /// A força de cada barreira por célula, para mostrar no mapa: 0 = nada, 1 = trava pouco (caminho, ribeira), 2 = trava bastante, 3 = trava quase por completo
    /// (autoestrada, rio). Pelo fator de bloqueio da classe, com os limites em `BarrierSettings.StrengthLimits`.
    /// </summary>
    public byte[] Strength(int cellCount)
    {
        var strength = new byte[cellCount];
        for (int i = 0; i < _cells.Length; i++)
            strength[_cells[i]] = (byte)(1 + _settings.StrengthLimits.Count(limit => _classes[i].BlockFactor <= limit));
        return strength;
    }

    /// <summary>Probabilidade de uma mancha da barreira ser galgada com este vento (km/h).</summary>
    public double BreachProbability(BarrierClass barrier, double windKmh) =>
        Math.Min(_settings.MaxBreach, barrier.BaseBreach + barrier.WindSensitivity * _settings.BreachPerKmh * Math.Max(0, windKmh - _settings.WindThresholdKmh));

    /// <summary>A propagação com as barreiras: `adjustment` limitada, em cada célula, pelo fator da barreira (ou pelo de fuga, nas manchas galgadas).</summary>
    public float[] Apply(float[] adjustment, double windKmh, int seed, double minFactor)
    {
        var result = (float[])adjustment.Clone();
        int patch = Math.Max(1, _settings.PatchCells);
        for (int i = 0; i < _cells.Length; i++)
        {
            int c = _cells[i], x = c % _width, y = c / _width;
            var barrier = _classes[i];
            bool breached = SpreadNoise.Lattice(x / patch, y / patch, seed) < BreachProbability(barrier, windKmh);
            double factor = breached ? Math.Max(barrier.BlockFactor, _settings.LeakFactor) : barrier.BlockFactor;
            result[c] = Math.Max((float)minFactor, Math.Min(result[c], (float)factor));
        }
        return result;
    }
}
