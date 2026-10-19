using System.Text.Json;
using FireTrace.Core.Common;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Models.Paging;
using FireTrace.Core.Repositories;
using FireTrace.Core.Services.Crud;
using Microsoft.Extensions.Time.Testing;

namespace FireTrace.Tests.Services;

public class CrudTests
{
    sealed class Policy : EntityPolicy<Vehicle>
    {
        public Policy() : base("veh") { }
        public override Task<IEnumerable<ValidationIssue>> ValidateAsync(Vehicle v, CancellationToken ct) =>
            Task.FromResult<IEnumerable<ValidationIssue>>(v.CrewCapacity < 0 ? new[] { new ValidationIssue("error", "invalid_crew", "crewCapacity negativo", "/crewCapacity") } : Array.Empty<ValidationIssue>());
        public override void EnsureDeletable(Vehicle v) { if (v.Callsign == "KEEP") throw new ConflictException("protegida"); }
    }

    static readonly FakeTimeProvider Clock = new(DateTimeOffset.Parse("2026-08-17T15:00:00Z"));
    static CrudService<Vehicle> Service() => new(new MemoryDocumentStore<Vehicle>(), new Policy(), Clock, new ShortGuidIdGenerator());
    static Vehicle Veh(string callsign = "VFCI-01", int crew = 5) => new() { OrganizationId = "org-1", Callsign = callsign, Type = VehicleType.ForestFirefightingVehicle, CrewCapacity = crew };

    [Fact]
    public async Task Create_assigns_id_and_dates_and_get_returns_it()
    {
        var svc = Service();
        var created = await svc.CreateAsync(Veh());
        Assert.StartsWith("veh-", created.Id);
        Assert.Equal(Clock.GetUtcNow(), created.CreatedAt);
        Assert.Equal(created, await svc.GetAsync(created.Id));
        await Assert.ThrowsAsync<NotFoundException>(() => svc.GetAsync("veh-nope"));
    }

    [Fact]
    public async Task Policy_errors_block_creation_with_a_validation_exception()
    {
        var ex = await Assert.ThrowsAsync<ValidationException>(() => Service().CreateAsync(Veh(crew: -1)));
        Assert.Equal("invalid_crew", ex.Issues[0].Code);
        Assert.Equal("/crewCapacity", ex.Issues[0].Pointer);
    }

    [Fact]
    public async Task Patch_follows_RFC_7396_merge_semantics()
    {
        var svc = Service();
        var v = await svc.CreateAsync(Veh() with { WaterCapacityL = 3000, Capabilities = new() { VehicleCapability.WildfireAttack } });
        Clock.Advance(TimeSpan.FromMinutes(5));
        var patched = await svc.PatchAsync(v.Id, JsonDocument.Parse("""{"callsign":"VFCI-02","waterCapacityL":null,"state":{"status":"on_scene","water":{"levelL":1000}}}""").RootElement);
        Assert.Equal("VFCI-02", patched.Callsign);
        Assert.Null(patched.WaterCapacityL);               // null apaga
        Assert.Equal(VehicleStatus.OnScene, patched.State.Status);
        Assert.Equal(1000, patched.State.Water!.LevelL);   // objetos fundem-se
        Assert.Equal(new[] { VehicleCapability.WildfireAttack }, patched.Capabilities); // o resto fica
        Assert.Equal(v.Id, patched.Id);
        Assert.Equal(v.CreatedAt, patched.CreatedAt);
        Assert.Equal(Clock.GetUtcNow(), patched.UpdatedAt);
    }

    [Fact]
    public async Task Patch_is_validated_and_does_not_store_invalid_changes()
    {
        var svc = Service();
        var v = await svc.CreateAsync(Veh());
        await Assert.ThrowsAsync<ValidationException>(() => svc.PatchAsync(v.Id, JsonDocument.Parse("""{"crewCapacity":-3}""").RootElement));
        Assert.Equal(5, (await svc.GetAsync(v.Id)).CrewCapacity);
        await Assert.ThrowsAsync<ValidationException>(() => svc.PatchAsync(v.Id, JsonDocument.Parse("""{"type":"not_a_type"}""").RootElement));
    }

    [Fact]
    public async Task Delete_respects_the_policy()
    {
        var svc = Service();
        var keep = await svc.CreateAsync(Veh("KEEP")); var other = await svc.CreateAsync(Veh("OTHER"));
        await Assert.ThrowsAsync<ConflictException>(() => svc.DeleteAsync(keep.Id));
        await svc.DeleteAsync(other.Id);
        await Assert.ThrowsAsync<NotFoundException>(() => svc.GetAsync(other.Id));
    }

    [Fact]
    public async Task Pages_use_cursors_and_updatedAfter()
    {
        var svc = Service();
        for (int i = 0; i < 5; i++) { Clock.Advance(TimeSpan.FromMinutes(1)); await svc.CreateAsync(Veh($"V{i}")); }
        var first = await svc.PageAsync(new PageQuery(Limit: 2));
        Assert.Equal(2, first.Items.Count); Assert.NotNull(first.NextCursor); Assert.Equal(5, first.Total);
        var second = await svc.PageAsync(new PageQuery(Limit: 2, Cursor: first.NextCursor));
        Assert.Equal(new[] { "V2", "V3" }, second.Items.Select(v => v.Callsign));
        var last = await svc.PageAsync(new PageQuery(Limit: 2, Cursor: second.NextCursor));
        Assert.Single(last.Items); Assert.Null(last.NextCursor);

        var recent = await svc.PageAsync(new PageQuery(50, UpdatedAfter: Clock.GetUtcNow().AddSeconds(-90)));
        Assert.Equal(new[] { "V3", "V4" }, recent.Items.Select(v => v.Callsign));
        var filtered = await svc.PageAsync(new PageQuery(50), v => v.Callsign == "V1");
        Assert.Single(filtered.Items);
    }
}
