using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Repositories;

namespace FireTrace.Core.Services.Policies;

public sealed class VehiclePolicy(IDocumentStore<Organization> organizations, IDocumentStore<Station> stations) : ReferencingPolicy<Vehicle>("veh", organizations, stations)
{
    public override Task<IEnumerable<ValidationIssue>> ValidateAsync(Vehicle v, CancellationToken ct) => Collect(async issues =>
    {
        await RequireOrganization(v.OrganizationId, issues, ct);
        await RequireStation(v.StationId, issues, ct);
        if (v.CrewCapacity < 0) issues.Add(new("error", "invalid_crew", "crewCapacity não pode ser negativo.", "/crewCapacity"));
        if (v.MinimumCrew > v.CrewCapacity) issues.Add(new("error", "invalid_crew", "minimumCrew excede crewCapacity.", "/minimumCrew"));
        if (v.State.CrewOnboard > v.CrewCapacity) issues.Add(new("error", "invalid_crew", "Há mais pessoas a bordo do que a capacidade.", "/state/crewOnboard"));
        if (v.Type is VehicleType.Helicopter or VehicleType.Airtanker && v.Aerial is null) issues.Add(new("warning", "missing_aerial", "Meios aéreos devem indicar `aerial`.", "/aerial"));
    });
}
