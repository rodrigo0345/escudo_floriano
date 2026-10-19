using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record MedicalStandbyAction : PlanAction { public List<Target>? Positions { get; init; } public LatLon? CasualtyCollectionPoint { get; init; } public List<string>? HospitalIds { get; init; } public string? HospitalAlert { get; init; } }
