using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Weather;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Scenarios;

public sealed record EngineOptions(EnsembleSpec? Ensemble = null, bool? Spotting = null, int? Seed = null);
