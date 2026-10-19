using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Rules;

namespace FireTrace.Core.Services.Routing;

/// <summary>As velocidades numa via: a típica da classe (FireTrace:Routing) vezes a fração que uma viatura atinge (FireTrace:Rules:Movement).</summary>
public sealed class RoadSpeeds(RoutingSettings routing, Rules rules)
{
    readonly Dictionary<string, double> _factor = rules.Movement.RoadSpeedFactor.ToDictionary(f => f.Highway, f => f.Factor);

    public MovementRules Movement => rules.Movement;

    /// <summary>Velocidade efetiva (km/h) numa via, para estimar tempos de chegada.</summary>
    public double Kmh(string highway)
    {
        var key = highway.EndsWith("_link") ? highway[..^5] : highway;
        return routing.RoadTypicalSpeedKmh.TryGetValue(key, out var kmh) && _factor.TryGetValue(key, out var factor) ? kmh * factor : routing.UnknownRoadSpeedKmh;
    }

    public TravelProfile Profile(bool allowOffRoad = false, bool emergency = true, double? maxSpeedKmh = null) => new(this, allowOffRoad, emergency, maxSpeedKmh);
}
