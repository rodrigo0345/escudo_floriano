using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

/// <summary>Como um meio se desloca: se usa caminhos florestais, se é de emergência (mais rápido) e o seu limite de velocidade.</summary>
public sealed record TravelProfile(RoadSpeeds Speeds, bool AllowOffRoad = false, bool Emergency = true, double? MaxSpeedKmh = null, double? WidthM = null, double? MaxSlopePercent = null)
{
    /// <summary>
    /// Minutos para percorrer o troço, ou nada se este perfil não pode passar nele: caminho florestal sem viatura todo-o-terreno, viatura mais larga que o troço (quando a largura é conhecida)
    /// ou declive acima do que a viatura vence. Acima do declive em que começa a penalização anda mais devagar.
    /// </summary>
    public double? Minutes(RoadEdge e, double cellM, double slopePercent = 0)
    {
        if (e.OffRoad && !AllowOffRoad) return null;
        if (WidthM is { } width && e.WidthM is { } roadWidth && width > roadWidth) return null;
        var rules = Speeds.Movement;
        if (slopePercent > (MaxSlopePercent ?? rules.SlopePenalty.MaxSlopeDefaultPercent)) return null;
        double kmh = e.OffRoad ? rules.OffRoadSpeedKmh : Speeds.Kmh(e.Highway);
        if (slopePercent > rules.SlopePenalty.StartsAtPercent) kmh *= Math.Max(0.2, 1 - rules.SlopePenalty.SlowdownPerPercent * (slopePercent - rules.SlopePenalty.StartsAtPercent));
        if (Emergency) kmh *= rules.EmergencyVehicleFactor;
        if (MaxSpeedKmh is { } cap) kmh = Math.Min(kmh, cap);
        return e.LengthCells * cellM / (kmh * 1000 / 60);
    }
}
