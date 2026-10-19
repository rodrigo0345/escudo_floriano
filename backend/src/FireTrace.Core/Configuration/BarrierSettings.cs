namespace FireTrace.Core.Configuration;

/// <summary>Barreiras (estradas, rios): galgadas por manchas, com probabilidade que sobe com o vento acima do limiar (projeção de faíscas, fogo que atravessa a faixa).</summary>
public sealed record BarrierSettings(double LeakFactor, int PatchCells, double WindThresholdKmh, double BreachPerKmh, double MaxBreach, double[] StrengthLimits,
    Dictionary<string, BarrierClass> Roads, Dictionary<string, BarrierClass> Waterways);
