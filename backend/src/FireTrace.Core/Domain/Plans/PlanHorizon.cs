using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

public sealed record PlanHorizon(DateTimeOffset Start, DateTimeOffset End);
