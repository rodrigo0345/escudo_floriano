using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Policies;

/// <summary>Cortes de estrada: o local existe, os troços existem e o fim é depois do início.</summary>
public sealed class RoadClosurePolicy(IMapReader map, IDocumentStore<Organization> organizations) : ReferencingPolicy<RoadClosure>("clo", organizations)
{
    public override Task<IEnumerable<ValidationIssue>> ValidateAsync(RoadClosure c, CancellationToken ct) => Collect(async issues =>
    {
        await RequireOrganization(c.ResponsibleOrganizationId, issues, ct, "/responsibleOrganizationId");
        if (map.Locations.Find(c.LocationId) is null) { issues.Add(new("error", "unknown_location", $"Local '{c.LocationId}' desconhecido.", "/locationId")); return; }
        if (c.RoadIds is not { Count: > 0 } && c.Geometry is null) issues.Add(new("error", "missing_target", "Indique `roadIds` ou `geometry`.", "/roadIds"));
        if (c.End is { } end && end <= c.Start) issues.Add(new("error", "invalid_period", "`end` tem de ser depois de `start`.", "/end"));
        if (c.RoadIds is { Count: > 0 } ids)
        {
            var net = await map.GetRoadsAsync(c.LocationId, ct);
            var known = net.Edges.Select(e => e.Id).ToHashSet();
            foreach (var (id, i) in ids.Select((id, i) => (id, i)))
                if (MapIds.RoadNumber(id) is not { } n || !known.Contains(n)) issues.Add(new("error", "unknown_road", $"Troço '{id}' desconhecido.", $"/roadIds/{i}"));
        }
    });
}
