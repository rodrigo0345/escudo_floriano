using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

public sealed record PlanBasis(string? ScenarioId = null, string? SimulationId = null, DateTimeOffset? SituationAsOf = null);
