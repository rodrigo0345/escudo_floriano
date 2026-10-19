using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Scenarios;

public sealed record Ignition(LatLon Position, string? Id = null, string? Label = null, int TimeOffsetMinutes = 0);
