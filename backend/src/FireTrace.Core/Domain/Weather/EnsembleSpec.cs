using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

/// <summary>Incerteza da meteorologia: cada membro perturba o vento, o rumo e a humidade para estimar probabilidades.</summary>
public sealed record EnsembleSpec
{
    // o que não vem no pedido decide-se em `FireTrace:Defaults:Ensemble` (appsettings.json)
    public int? Members { get; init; }
    public int? Seed { get; init; }
    public NumberRange? WindSpeedFactor { get; init; }
    public double? WindDirectionSigmaDeg { get; init; }
    public NumberRange? HumidityFactor { get; init; }
    public NumberRange? FuelMoistureFactor { get; init; }
}
