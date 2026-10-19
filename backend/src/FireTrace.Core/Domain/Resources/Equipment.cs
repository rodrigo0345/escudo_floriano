using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record Equipment : Entity
{
    public required string OrganizationId { get; init; }
    public required EquipmentKind Kind { get; init; }
    public string? Label { get; init; }
    public string? StationId { get; init; }
    public required int Quantity { get; init; }
    public required int Available { get; init; }
    public string? Notes { get; init; }
    public int InUse { get; init; }
}
