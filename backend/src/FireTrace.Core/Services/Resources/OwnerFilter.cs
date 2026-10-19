using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Resources;
using FireTrace.Core.Repositories;

namespace FireTrace.Core.Services.Resources;

/// <summary>
/// Os filtros que todos os meios partilham (`organizationId`, `organizationType`, `stationId`, `locationId`), escritos uma só vez.
/// O local de um meio é o local do seu posto.
/// </summary>
public sealed class OwnerFilter(IDocumentStore<Organization> organizations, IDocumentStore<Station> stations)
{
    public async Task<Func<T, bool>> BuildAsync<T>(OwnerQuery q, Func<T, string> organizationOf, Func<T, string?> stationOf, CancellationToken ct)
    {
        var (orgId, stationId, locationId, types) = (q.OrganizationId, q.StationId, q.LocationId, q.OrganizationTypes);

        var orgsOfType = types.Count == 0 ? null : (await organizations.ListAsync(ct)).Where(o => types.Contains(o.Type)).Select(o => o.Id).ToHashSet();
        var stationsHere = locationId is null ? null : (await stations.ListAsync(ct)).Where(s => s.LocationId == locationId).Select(s => s.Id).ToHashSet();

        return item => (orgId is null || organizationOf(item) == orgId)
            && (stationId is null || stationOf(item) == stationId)
            && (orgsOfType is null || orgsOfType.Contains(organizationOf(item)))
            && (stationsHere is null || (stationOf(item) is { } s && stationsHere.Contains(s)));
    }
}
