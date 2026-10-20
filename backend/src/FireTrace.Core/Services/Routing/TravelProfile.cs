using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

/// <summary>Como um meio se desloca: se usa caminhos florestais, se é de emergência (mais rápido) e o seu limite de velocidade.</summary>
public sealed record TravelProfile(RoadSpeeds Speeds, bool AllowOffRoad = false, bool Emergency = true, double? MaxSpeedKmh = null, double? WidthM = null, double? MaxSlopePercent = null, string? VehicleType = null, double? WeightT = null)
{
    /// <summary>
    /// Minutos para percorrer o troço, ou nada se este perfil não pode passar nele: caminho florestal sem viatura todo-o-terreno, viatura mais larga que o troço (quando a largura é conhecida)
    /// ou declive acima do que a viatura vence. O tempo vem de <see cref="RoadSpeeds.Minutes"/> (piso, declive, curvas, cruzamentos, tipo e peso da viatura).
    /// </summary>
    public double? Minutes(RoadEdge e, double cellM, double slopePercent = 0)
    {
        if (e.OffRoad && !AllowOffRoad) return null;
        if (WidthM is { } width && e.WidthM is { } roadWidth && width > roadWidth) return null;
        if (slopePercent > (MaxSlopePercent ?? Speeds.Movement.SlopePenalty.MaxSlopeDefaultPercent)) return null;
        return Speeds.Minutes(e, cellM, slopePercent, this);
    }
}
