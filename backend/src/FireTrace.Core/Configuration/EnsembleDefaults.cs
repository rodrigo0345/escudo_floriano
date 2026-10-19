using FireTrace.Core.Domain.Weather;

namespace FireTrace.Core.Configuration;

public sealed record EnsembleDefaults(int Members, int Seed, NumberRange WindSpeedFactor, double WindDirectionSigmaDeg, NumberRange HumidityFactor, NumberRange FuelMoistureFactor);
