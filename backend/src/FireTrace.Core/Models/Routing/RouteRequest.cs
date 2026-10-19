using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record RouteRequest(string LocationId, LatLon To, LatLon? From = null, string? FromStationId = null, DateTimeOffset? At = null, string? SimulationId = null,
    VehicleProfile? Vehicle = null, AvoidOptions? Avoid = null, bool EmergencyVehicle = true);
