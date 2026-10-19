using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Models.Resources;

public sealed record VehicleBrief(string VehicleId, string Callsign, VehicleType Type, string OrganizationId, VehicleStatus Status, LatLon? Position, int Personnel,
    string? DispatchId, Target? Target, double? EtaMinutes);
