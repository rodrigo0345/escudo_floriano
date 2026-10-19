using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Common;

public sealed record ActorRef(string Kind, string? Id = null, string? Name = null, string? OrganizationId = null);
