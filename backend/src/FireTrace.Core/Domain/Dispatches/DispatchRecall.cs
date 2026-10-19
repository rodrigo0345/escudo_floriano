using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Dispatches;

public sealed record DispatchRecall(string? Reason = null, string? ReturnToStationId = null);
