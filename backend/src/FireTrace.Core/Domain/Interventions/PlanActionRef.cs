using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

public sealed record PlanActionRef(string PlanId, string ActionId);
