using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans.Triggers;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Services.Operations;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using NetTopologySuite.Geometries;

namespace FireTrace.Tests.Services;

public class OperationSimulatorTests
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
    static readonly DateTimeOffset Start = new(2026, 8, 17, 15, 0, 0, TimeSpan.Zero);
    static readonly LatLon Home = new(41.0, -8.2);
    static readonly LatLon Site = new(41.0, -8.0);

    static Vehicle Truck(double? waterL = 3000, double? pumpLpm = 1000) => new()
    {
        Id = "veh-1", OrganizationId = "org-1", Callsign = "VFCI-1", Type = VehicleType.ForestFirefightingVehicle, CrewCapacity = 5, StationId = "sta-1", WaterCapacityL = waterL, PumpFlowLpm = pumpLpm,
    };

    static IReadOnlyList<UnitTimeline> Run(Vehicle vehicle, double eta, int? stay, double departAt = 0, int minutes = 240)
    {
        var route = Gf.CreateLineString(new[] { new Coordinate(Home.Lon, Home.Lat), new Coordinate(-8.1, 41.0), new Coordinate(Site.Lon, Site.Lat) });
        var action = new FireAttackAction
        {
            Id = "act-1", Title = "Ataque", OrganizationId = "org-1", Tactic = "direct", ExpectedDurationMinutes = stay,
            Trigger = departAt > 0 ? new AtTimeTrigger(new TimeSpec(OffsetMinutes: (int)departAt)) : null,
            Resources = new() { new ResourceAssignment(ResourceType.Vehicle, vehicle.Id, 5, Responsibility: Responsibility.Firefighting, FromStationId: "sta-1", EtaMinutes: eta, Route: route) },
        };
        var plan = new Plan { LocationId = "loc", Title = "Plano", Actions = new() { action }, Horizon = new PlanHorizon(Start, Start.AddHours(4)) };
        return OperationSimulator.Simulate(plan, Start, minutes, new Dictionary<string, Vehicle> { [vehicle.Id] = vehicle }, new Dictionary<string, PersonnelPool>(),
            new Dictionary<string, LatLon> { ["sta-1"] = Home }, new Dictionary<string, LatLon> { ["act-1"] = Site }, TestSettings.All.Rules, 30);
    }

    [Fact]
    public void A_unit_waits_drives_for_its_eta_works_and_goes_home()
    {
        var u = Run(Truck(), eta: 20, stay: 60).Single();
        UnitTrackPoint At(int m) => u.Points[m];
        Assert.Equal(DispatchStatus.EnRoute, At(0).Status);                                  // sem gatilho de hora, parte logo
        Assert.Equal(Home, At(0).Position);                                                  // do posto
        Assert.Equal(DispatchStatus.EnRoute, At(5).Status);
        Assert.Equal(-8.1, At(10).Position!.Lon, 3);                                         // a meio do tempo, a meio do caminho
        Assert.Equal(DispatchStatus.Working, At(25).Status);                                 // chegou aos 20 min e trabalha
        Assert.Equal(Site, At(25).Position);
        Assert.Equal(DispatchStatus.Returning, At(85).Status);                               // a ação acabou aos 80 min e volta pelo mesmo caminho
        Assert.Equal(DispatchStatus.Completed, At(110).Status);                              // 80 + 20 de regresso
        Assert.Equal(new[] { "departed", "arrived", "started_working", "returned" }, u.Events.Where(e => e.Type != "water_empty" && !e.Type.StartsWith("refill")).Select(e => e.Type));
    }

    [Fact]
    public void A_departure_trigger_delays_the_whole_trip()
    {
        var u = Run(Truck(), eta: 20, stay: 60, departAt: 30).Single();
        Assert.Equal(DispatchStatus.Ordered, u.Points[29].Status);
        Assert.Equal(DispatchStatus.EnRoute, u.Points[31].Status);
        Assert.Equal(DispatchStatus.Working, u.Points[55].Status);                          // 30 + 20 = chega aos 50
    }

    [Fact]
    public void A_tank_runs_dry_and_the_engine_goes_to_refill_with_the_backends_water_cycle()
    {
        var u = Run(Truck(waterL: 3000, pumpLpm: 1000), eta: 10, stay: 120).Single();
        var perFill = 3000 / (1000 * TestSettings.All.Rules.Water.DutyCycle);
        Assert.Contains(u.Events, e => e.Type == "water_empty");
        Assert.Contains(u.Events, e => e.Type == "refill_started");
        Assert.Contains(u.Events, e => e.Type == "refill_done");
        Assert.Contains(u.Points, p => p.Status == DispatchStatus.Refilling);
        var firstEmpty = u.Events.First(e => e.Type == "water_empty").TMin;
        Assert.Equal(10 + perFill, firstEmpty, 0);                                           // esvazia ao fim de água / (bomba × ciclo de trabalho)
        Assert.True(u.Points[firstEmpty - 1].WaterLevelL < u.Points[10].WaterLevelL);        // a água desce enquanto trabalha
        Assert.Equal(0, u.Points[firstEmpty].WaterLevelL);                                   // e está vazia quando acaba
    }

    [Fact]
    public void Fatigue_grows_while_a_crew_works_and_a_unit_without_water_never_stops_to_refill()
    {
        var dry = Run(Truck(waterL: null, pumpLpm: null), eta: 10, stay: 120).Single();
        Assert.DoesNotContain(dry.Events, e => e.Type.StartsWith("refill"));
        Assert.Equal(0, dry.Points[5].FatiguePct);                                           // ainda a caminho: descansada
        Assert.True(dry.Points[100].FatiguePct > 0);                                         // depois de trabalhar, cansada
        Assert.Null(dry.WaterCapacityL);
    }

    [Fact]
    public void The_same_plan_gives_the_same_tracks()
    {
        var a = Run(Truck(), 15, 90).Single();
        var b = Run(Truck(), 15, 90).Single();
        Assert.Equal(a.Points, b.Points);
        Assert.Equal(a.Events, b.Events);
    }

    [Fact]
    public void The_state_at_a_minute_reports_what_is_left_to_travel()
    {
        var u = Run(Truck(), eta: 20, stay: 60).Single();
        var state = OperationSimulator.StateAt(u, 5);
        Assert.Equal(DispatchStatus.EnRoute, state.Status);
        Assert.Equal(15, state.EtaMinutes);
        Assert.Equal("act-1", u.ActionId);
        Assert.Equal(5, state.Personnel);
        Assert.Null(OperationSimulator.StateAt(u, 40).EtaMinutes);
    }
}
