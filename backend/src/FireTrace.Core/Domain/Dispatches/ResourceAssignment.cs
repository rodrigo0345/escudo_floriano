using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Dispatches;

/// <summary>Meio concreto reservado por uma ação, com as pessoas e a função que desempenha.</summary>
public sealed record ResourceAssignment(ResourceType ResourceType, string ResourceId, int? Personnel = null, int? Quantity = null, Responsibility? Responsibility = null,
    string? Notes = null, string? FromStationId = null, double? EtaMinutes = null, LineString? Route = null);
