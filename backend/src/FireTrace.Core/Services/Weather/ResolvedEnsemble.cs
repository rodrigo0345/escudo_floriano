using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Weather;

namespace FireTrace.Core.Services.Weather;

/// <summary>Um ensemble com todos os valores já decididos (os do pedido, ou os por omissão de `FireTrace:Defaults:Ensemble`).</summary>
public sealed record ResolvedEnsemble(int Members, int Seed, NumberRange WindSpeedFactor, double WindDirectionSigmaDeg, NumberRange HumidityFactor, NumberRange FuelMoistureFactor)
{
    public static ResolvedEnsemble Of(EnsembleSpec? spec, EnsembleDefaults d) => new(spec?.Members ?? d.Members, spec?.Seed ?? d.Seed, spec?.WindSpeedFactor ?? d.WindSpeedFactor,
        spec?.WindDirectionSigmaDeg ?? d.WindDirectionSigmaDeg, spec?.HumidityFactor ?? d.HumidityFactor, spec?.FuelMoistureFactor ?? d.FuelMoistureFactor);
}
