using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Policies;

public sealed class StationPolicy(IDocumentStore<Organization> organizations, IMapReader map, IDocumentStore<Vehicle> vehicles) : ReferencingPolicy<Station>("sta", organizations)
{
    public override Task<IEnumerable<ValidationIssue>> ValidateAsync(Station s, CancellationToken ct) => Collect(async issues =>
    {
        await RequireOrganization(s.OrganizationId, issues, ct);
        var loc = map.Locations.Find(s.LocationId);
        if (loc is null) issues.Add(new("error", "unknown_location", $"Local '{s.LocationId}' desconhecido.", "/locationId"));
        else if (loc.Spec.CellAt(s.Position.Lat, s.Position.Lon) < 0) issues.Add(new("warning", "outside_location", "O posto está fora da área do local.", "/position"));
    });

    public override void EnsureDeletable(Station s)
    {
        if (vehicles.ListAsync().Result.Any(v => v.StationId == s.Id)) throw new ConflictException("Há viaturas neste posto; mude-as de posto primeiro.", "station_in_use");
    }
}
