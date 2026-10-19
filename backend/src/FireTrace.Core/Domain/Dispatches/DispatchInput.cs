using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Dispatches;

/// <summary>Pedido de despacho (um por meio). O servidor completa o resto.</summary>
public sealed record DispatchInput(ResourceType ResourceType, string ResourceId, int Personnel, Responsibility Responsibility, Target Target,
    string? FromStationId = null, DateTimeOffset? StartAt = null, int? ExpectedDurationMinutes = null, LineString? Route = null, string? Notes = null);
