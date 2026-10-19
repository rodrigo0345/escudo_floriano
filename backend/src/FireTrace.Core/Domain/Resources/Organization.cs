using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record Organization : Entity
{
    public required string Name { get; init; }
    public string? ShortName { get; init; }
    public required OrganizationType Type { get; init; }
    public string? ParentOrganizationId { get; init; }
    public Jurisdiction? Jurisdiction { get; init; }
    public OperationsCenter? OperationsCenter { get; init; }
    public List<Contact>? Contacts { get; init; }
    public bool Active { get; init; } = true;
}
