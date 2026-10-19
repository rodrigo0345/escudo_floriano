using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record RequestReinforcementsAction : PlanAction
{
    public string? FromOrganizationId { get; init; }
    public string? Region { get; init; }
    public List<VehicleRequest>? Vehicles { get; init; }
    public List<PersonnelRequest>? Personnel { get; init; }
    public Target? AssemblyPoint { get; init; }
    public TimeSpec? NeedBy { get; init; }
}
