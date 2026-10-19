using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Scenarios;

public sealed record ResourceAdjustment(string Target, string TargetId, string? Availability = null, int? QuantityDelta = null, DateTimeOffset? From = null, DateTimeOffset? Until = null, string? Reason = null);
