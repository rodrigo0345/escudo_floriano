using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Scenarios;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Simulations;

public sealed record SimulationRequest(string? ScenarioId = null, Scenario? Scenario = null, string? Label = null, SimulationKind Kind = SimulationKind.Baseline,
    string? PlanId = null, bool IncludeActiveDispatches = false, EngineOptions? Engine = null);
