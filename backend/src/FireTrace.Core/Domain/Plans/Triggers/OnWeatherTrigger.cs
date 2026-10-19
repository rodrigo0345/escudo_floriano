using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Triggers;

public sealed record OnWeatherTrigger(string Variable, string Operator, double Threshold, int? SustainedMinutes = null) : Trigger;
