using FireTrace.Core.Domain.Resources;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Operations;

/// <summary>O meio concreto de um despacho: onde está e (nos grupos de pessoal) quantas pessoas estão livres.</summary>
public sealed record DispatchSubject(string Id, string OrganizationId, string? StationId, string? LocationId, LatLon? Position, Vehicle? Vehicle = null, int Available = int.MaxValue);
