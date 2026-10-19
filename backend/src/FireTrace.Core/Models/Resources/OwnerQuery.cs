using FireTrace.Core.Domain.Resources;

namespace FireTrace.Core.Models.Resources;

/// <summary>Os filtros de pertença que a maioria das listas aceita.</summary>
public sealed record OwnerQuery(string? OrganizationId, string? StationId, string? LocationId, IReadOnlySet<OrganizationType> OrganizationTypes);
