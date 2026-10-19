using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Scenarios;

public sealed record ScenarioResources(string Source = "live", List<string>? OrganizationIds = null, List<ResourceAdjustment>? Adjustments = null);
