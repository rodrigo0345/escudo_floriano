using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Weather;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Domain.Fire;

/// <summary>
/// O resultado guardado de uma simulação: a corrida central (`Ignition`) e as dos membros do ensemble, cada uma como o minuto em que cada
/// célula começa a arder (−1 = não arde). Qualquer instante, perímetro ou impacto deriva daqui, sem guardar imagens.
/// </summary>
public sealed class FireRun
{
    public required string SimulationId { get; init; }
    public required string LocationId { get; init; }
    public required GridSpec Spec { get; init; }
    public required DateTimeOffset Start { get; init; }
    public required int DurationMinutes { get; init; }
    public required int[] Ignition { get; init; }
    public required int[][] Members { get; init; }
    public required ushort[] IntensityKwm { get; init; }
    public required byte[] Flags { get; init; }
    /// <summary>Meteorologia efetivamente usada (de 10 em 10 minutos, a partir do início).</summary>
    public required IReadOnlyList<WeatherSample> Weather { get; init; }
    /// <summary>Fração de cada célula que continua a contar como edifício afetado (1 = sem proteção); nulo se nenhuma proteção foi aplicada.</summary>
    public float[]? BuildingFactor { get; init; }

    /// <summary>Corrida de um percentil: a central para p50/média, ou o membro na posição 10 % / 90 % por área ardida.</summary>
    public int[] Pick(string? percentile)
    {
        if (Members.Length == 0 || percentile is null or "p50" or "mean") return Ignition;
        var ordered = Members.OrderBy(m => m.Count(v => v >= 0)).ToArray();
        return percentile == "p10" ? ordered[(int)(ordered.Length * 0.1)] : ordered[Math.Min(ordered.Length - 1, (int)(ordered.Length * 0.9))];
    }

    /// <summary>A corrida central mais os membros: a amostra de onde saem as probabilidades.</summary>
    public IReadOnlyList<int[]> Ensemble => Members.Length == 0 ? new[] { Ignition } : Members;

    public WeatherSample WeatherAt(int minute) => Weather.OrderBy(w => Math.Abs((w.Time - Start.AddMinutes(minute)).TotalSeconds)).First();
}
