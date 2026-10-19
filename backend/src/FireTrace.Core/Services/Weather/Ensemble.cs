using FireTrace.Core.Domain.Weather;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Weather;

namespace FireTrace.Core.Services.Weather;

/// <summary>Os membros do ensemble: a corrida central ("rep") e cópias com vento, rumo e humidade do combustível perturbados (sempre os mesmos para a mesma semente).</summary>
public static class Ensemble
{
    public static IReadOnlyList<MemberWeather> Members(WeatherTrack central, ResolvedEnsemble spec, int count, int maxMembers)
    {
        var members = new List<MemberWeather>();
        for (int i = 0; i < Math.Clamp(count, 0, maxMembers); i++)
        {
            var rng = new Random(unchecked((int)((ulong)spec.Seed * 2654435761UL) ^ (i * 7919)));
            double Normal() => Math.Sqrt(-2 * Math.Log(1 - rng.NextDouble())) * Math.Cos(2 * Math.PI * rng.NextDouble());
            double Between(NumberRange r) => r.Min + (r.Max - r.Min) * rng.NextDouble();
            members.Add(new($"m{i}", central.Perturbed(Between(spec.WindSpeedFactor), spec.WindDirectionSigmaDeg * Normal(), Between(spec.HumidityFactor) * Between(spec.FuelMoistureFactor))));
        }
        return members;
    }
}
