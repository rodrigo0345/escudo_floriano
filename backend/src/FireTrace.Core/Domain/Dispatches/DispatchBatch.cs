using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Dispatches;

public sealed record DispatchBatch(List<DispatchInput> Dispatches, string? Reason = null);
