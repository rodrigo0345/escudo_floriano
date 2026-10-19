using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Crud;

namespace FireTrace.Core.Services.Policies;

/// <summary>Verificações partilhadas pelas regras de cada recurso: as referências a outros recursos têm de existir.</summary>
public abstract class ReferencingPolicy<T>(string prefix, IDocumentStore<Organization> organizations, IDocumentStore<Station>? stations = null) : EntityPolicy<T>(prefix) where T : Entity
{
    protected async Task RequireOrganization(string? id, List<ValidationIssue> issues, CancellationToken ct, string pointer = "/organizationId")
    {
        if (id is not null && await organizations.GetAsync(id, ct) is null) issues.Add(new("error", "unknown_organization", $"Organização '{id}' desconhecida.", pointer));
    }

    protected async Task RequireStation(string? id, List<ValidationIssue> issues, CancellationToken ct)
    {
        if (id is not null && stations is not null && await stations.GetAsync(id, ct) is null) issues.Add(new("error", "unknown_station", $"Posto '{id}' desconhecido.", "/stationId"));
    }

    protected static async Task<IEnumerable<ValidationIssue>> Collect(Func<List<ValidationIssue>, Task> check)
    {
        var issues = new List<ValidationIssue>();
        await check(issues);
        return issues;
    }
}
