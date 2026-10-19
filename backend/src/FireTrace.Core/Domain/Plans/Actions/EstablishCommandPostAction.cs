using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record EstablishCommandPostAction : PlanAction { public required Target Location { get; init; } public string? RadioChannel { get; init; } public string? CommandOrganizationId { get; init; } public string? HostVehicleId { get; init; } }
