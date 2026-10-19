using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Resources;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Resources;

/// <summary>The filters of `GET /vehicles`: ownership, type, state, capabilities and "near this point".</summary>
public sealed record VehicleQuery(OwnerQuery Owner, IReadOnlySet<VehicleType> Types, IReadOnlySet<VehicleStatus> Statuses, IReadOnlySet<Responsibility> Responsibilities,
    IReadOnlySet<VehicleCapability> Capabilities, bool? OffRoad, bool? InService, LatLon? Near, double? RadiusM);
