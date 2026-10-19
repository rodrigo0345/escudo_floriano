using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

/// <summary>Pessoal agregado por função (não são pessoas individuais, por privacidade e simplicidade).</summary>
public sealed record PersonnelPool : Entity
{
    public required string OrganizationId { get; init; }
    public required PersonnelRole Role { get; init; }
    public string? StationId { get; init; }
    public required int Total { get; init; }
    /// <summary>Livre agora, sem despacho. As pessoas despachadas contam em <see cref="Deployed"/>.</summary>
    public required int Available { get; init; }
    public ShiftWindow? OnShift { get; init; }
    public double? FatiguePct { get; init; }
    public List<string>? Certifications { get; init; }
    public string? Notes { get; init; }
    public int Deployed { get; init; }
    public List<Deployment>? Deployments { get; init; }
}
