using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Map;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Models.Resources;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Resources;

/// <summary>Quadros de meios de um local: o que cada organização tem e quem está a fazer o quê agora.</summary>
public sealed class ResourceOverview(IDocumentStore<Organization> organizations, IDocumentStore<Station> stations, IDocumentStore<Vehicle> vehicles,
    IDocumentStore<PersonnelPool> pools, IDocumentStore<Equipment> equipment, IDocumentStore<Dispatch> dispatches, IMapReader map, TimeProvider clock)
{
    sealed record Inventory(IReadOnlyList<Organization> Organizations, IReadOnlyList<Vehicle> Vehicles, IReadOnlyList<PersonnelPool> Pools, IReadOnlyList<Equipment> Equipment);

    /// <summary>Os meios que pertencem a um local: os dos seus postos (os que não têm posto contam para qualquer local).</summary>
    async Task<Inventory> InventoryAsync(string locationId, CancellationToken ct)
    {
        map.Locations.Get(locationId);
        var here = (await stations.ListAsync(ct)).Where(s => s.LocationId == locationId).Select(s => s.Id).ToHashSet();
        bool Mine(string? stationId) => stationId is null || here.Contains(stationId);
        return new Inventory(await organizations.ListAsync(ct), (await vehicles.ListAsync(ct)).Where(v => Mine(v.StationId)).ToList(),
            (await pools.ListAsync(ct)).Where(p => Mine(p.StationId)).ToList(), (await equipment.ListAsync(ct)).Where(e => Mine(e.StationId)).ToList());
    }

    static string Key<E>(E value) where E : struct, Enum => EnumText.ToSnake(value);

    static IReadOnlyList<CountBreakdown> Count<T>(IEnumerable<T> items, Func<T, IEnumerable<string>> keys, Func<T, int> total, Func<T, int> available) =>
        items.SelectMany(i => keys(i).Select(k => (Key: k, Item: i))).GroupBy(x => x.Key)
            .Select(g => new CountBreakdown(g.Key, g.Sum(x => total(x.Item)), g.Sum(x => available(x.Item)))).OrderBy(c => c.Key).ToList();

    static InventoryTotals Totals(IReadOnlyList<Vehicle> v, IReadOnlyList<PersonnelPool> p, IReadOnlyList<Equipment> e)
    {
        static int Free(Vehicle x) => x.InService && x.State.Status == VehicleStatus.Available ? 1 : 0;
        var byResponsibility = v.Where(x => x.State.Responsibility is not null).GroupBy(x => x.State.Responsibility!.Value)
            .ToDictionary(g => g.Key, g => (Vehicles: g.Count(), Personnel: g.Sum(x => x.State.CrewOnboard ?? 0)));
        foreach (var d in p.SelectMany(x => x.Deployments ?? new()))
            byResponsibility[d.Responsibility] = byResponsibility.TryGetValue(d.Responsibility, out var c) ? (c.Vehicles, c.Personnel + d.Personnel) : (0, d.Personnel);
        return new InventoryTotals(
            Count(v, x => new[] { Key(x.Type) }, _ => 1, Free),
            Count(v, x => new[] { Key(x.State.Status) }, _ => 1, Free),
            Count(p, x => new[] { Key(x.Role) }, x => x.Total, x => x.Available),
            Count(e, x => new[] { Key(x.Kind) }, x => x.Quantity, x => x.Available),
            Count(v, x => (x.Capabilities ?? new()).Select(Key), _ => 1, Free),
            byResponsibility.OrderBy(kv => kv.Key).Select(kv => new ResponsibilityCount(kv.Key, kv.Value.Vehicles, kv.Value.Personnel)).ToList());
    }

    public async Task<ResourceSummary> SummaryAsync(string locationId, CancellationToken ct)
    {
        var inv = await InventoryAsync(locationId, ct);
        var entries = inv.Organizations.Select(o => new ResourceSummaryEntry(o.Id, o.Name, o.Type,
                Totals(inv.Vehicles.Where(x => x.OrganizationId == o.Id).ToList(), inv.Pools.Where(x => x.OrganizationId == o.Id).ToList(), inv.Equipment.Where(x => x.OrganizationId == o.Id).ToList())))
            .Where(e => e.Totals.VehiclesByType.Count + e.Totals.PersonnelByRole.Count + e.Totals.EquipmentByKind.Count > 0).ToList();
        return new ResourceSummary(locationId, clock.GetUtcNow(), entries, Totals(inv.Vehicles, inv.Pools, inv.Equipment));
    }

    public async Task<DeploymentOverview> DeploymentAsync(string locationId, CancellationToken ct)
    {
        var inv = await InventoryAsync(locationId, ct);
        var active = (await dispatches.ListAsync(ct)).Where(d => d.IsActive).ToList();
        var byVehicle = active.Where(d => d.ResourceType == ResourceType.Vehicle).ToDictionary(d => d.ResourceId, d => d);

        VehicleBrief Brief(Vehicle v)
        {
            byVehicle.TryGetValue(v.Id, out var d);
            return new VehicleBrief(v.Id, v.Callsign, v.Type, v.OrganizationId, v.State.Status, v.State.Position, v.State.CrewOnboard ?? d?.Personnel ?? 0,
                v.State.CurrentDispatchId ?? d?.Id, v.State.Target ?? d?.Target, d?.EtaMinutes);
        }

        static bool Down(Vehicle v) => !v.InService || v.State.Status is VehicleStatus.OutOfService or VehicleStatus.Maintenance or VehicleStatus.Unavailable;
        var groups = inv.Vehicles.Where(v => !Down(v) && v.State.Responsibility is not null).GroupBy(v => v.State.Responsibility!.Value)
            .Select(g => new DeploymentGroup(g.Key, g.Select(Brief).ToList(), g.Count(), g.Sum(v => v.State.CrewOnboard ?? 0))).OrderBy(g => g.Responsibility).ToList();
        var idle = inv.Vehicles.Where(v => !Down(v) && v.State.Responsibility is null).Select(Brief).ToList();
        return new DeploymentOverview(locationId, clock.GetUtcNow(), groups,
            new IdleResources(idle, inv.Pools.Sum(p => p.Available), Count(inv.Pools, p => new[] { Key(p.Role) }, p => p.Total, p => p.Available)),
            new UnavailableResources(inv.Vehicles.Where(Down).Select(Brief).ToList(), 0), active);
    }
}
