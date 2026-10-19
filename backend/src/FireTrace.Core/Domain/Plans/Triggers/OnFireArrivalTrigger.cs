using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Triggers;

public sealed record OnFireArrivalTrigger(Target Target, int LeadTimeMinutes = 0, double? BufferM = null, string Percentile = "p50") : Trigger;
