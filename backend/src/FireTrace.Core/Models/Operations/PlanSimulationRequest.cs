using System.Text.Json;
using System.Text.RegularExpressions;
using FireTrace.Core.Domain.Scenarios;

namespace FireTrace.Core.Models.Operations;

public sealed record PlanSimulationRequest(string? BaselineSimulationId = null, string? Label = null, EngineOptions? Engine = null);
