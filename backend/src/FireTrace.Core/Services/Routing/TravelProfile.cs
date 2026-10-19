using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Routing;

/// <summary>Como um meio se desloca: se usa caminhos florestais, se é de emergência (mais rápido) e o seu limite de velocidade.</summary>
public sealed record TravelProfile(RoadSpeeds Speeds, bool AllowOffRoad = false, bool Emergency = true, double? MaxSpeedKmh = null)
{
    /// <summary>Minutos para percorrer o troço, ou nada se este perfil não pode passar nele.</summary>
    public double? Minutes(RoadEdge e, double cellM)
    {
        if (e.OffRoad && !AllowOffRoad) return null;
        var rules = Speeds.Movement;
        double kmh = e.OffRoad ? rules.OffRoadSpeedKmh : Speeds.Kmh(e.Highway);
        if (Emergency) kmh *= rules.EmergencyVehicleFactor;
        if (MaxSpeedKmh is { } cap) kmh = Math.Min(kmh, cap);
        return e.LengthCells * cellM / (kmh * 1000 / 60);
    }
}
