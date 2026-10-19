using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

public sealed record PlanRisk(string Description, string? Likelihood = null, string? Impact = null, string? Mitigation = null);
