namespace FireTrace.Engine.Contracts;

/// <summary>Resultado de uma corrida do motor de fogo: minuto de ignição por célula (−1 = não ardeu), intensidade (kW/m) e fogo de copas.</summary>
public sealed class FireResult
{
    public required int[] Ignition { get; init; }
    public required ushort[] IntensityKwm { get; init; }
    public required byte[] Flags { get; init; }
}
