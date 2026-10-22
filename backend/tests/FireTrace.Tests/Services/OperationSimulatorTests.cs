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
        var perFill = 3000 / TestSettings.All.Rules.Water.WorkingLpm(1000);                   // as linhas de ataque, não o caudal todo da bomba
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
    public void A_vehicle_works_parked_where_its_road_ends_not_on_the_fire_line()
    {
        var roadEnd = new LatLon(41.0, -8.002);                                              // a estrada acaba ~170 m antes da linha
        var route = Gf.CreateLineString(new[] { new Coordinate(Home.Lon, Home.Lat), new Coordinate(roadEnd.Lon, roadEnd.Lat) });
        var action = new FireAttackAction
        {
            Id = "act-1", Title = "Ataque", OrganizationId = "org-1", Tactic = "direct", ExpectedDurationMinutes = 60,
            Resources = new() { new ResourceAssignment(ResourceType.Vehicle, "veh-1", 5, Responsibility: Responsibility.Firefighting, FromStationId: "sta-1", EtaMinutes: 20, Route: route) },
        };
        var plan = new Plan { LocationId = "loc", Title = "Plano", Actions = new() { action }, Horizon = new PlanHorizon(Start, Start.AddHours(4)) };
        var u = OperationSimulator.Simulate(plan, Start, 120, new Dictionary<string, Vehicle> { ["veh-1"] = Truck() }, new Dictionary<string, PersonnelPool>(),
            new Dictionary<string, LatLon> { ["sta-1"] = Home }, new Dictionary<string, LatLon> { ["act-1"] = Site }, TestSettings.All.Rules, 30).Single();
        Assert.Equal(DispatchStatus.Working, u.Points[25].Status);
        Assert.Equal(roadEnd, u.Points[25].Position);                                        // a equipa vai a pé; a viatura fica na estrada
    }

    [Fact]
    public void A_ground_vehicle_without_a_road_to_its_target_never_drives_across_the_mountain()
    {
        var action = new FireAttackAction
        {
            Id = "act-1", Title = "Ataque", OrganizationId = "org-1", Tactic = "direct", ExpectedDurationMinutes = 60,
            Resources = new() { new ResourceAssignment(ResourceType.Vehicle, "veh-1", 5, Responsibility: Responsibility.Firefighting, FromStationId: "sta-1", EtaMinutes: 20) },
        };
        var plan = new Plan { LocationId = "loc", Title = "Plano", Actions = new() { action }, Horizon = new PlanHorizon(Start, Start.AddHours(4)) };
        var u = OperationSimulator.Simulate(plan, Start, 120, new Dictionary<string, Vehicle> { ["veh-1"] = Truck() }, new Dictionary<string, PersonnelPool>(),
            new Dictionary<string, LatLon> { ["sta-1"] = Home }, new Dictionary<string, LatLon> { ["act-1"] = Site }, TestSettings.All.Rules, 30).Single();
        Assert.All(u.Points, p => Assert.Equal(Home, p.Position));                         // fica no posto
        Assert.Equal(DispatchStatus.Failed, u.Points[30].Status);
    }

    [Fact]
    public void An_empty_engine_drives_by_road_to_the_water_point_fills_up_at_its_flow_and_comes_back()
    {
        var rules = TestSettings.All.Rules;
        var work = new LatLon(41.0, -8.0);
        var tank = new LatLon(41.0, -7.95);
        var road = RoutePath.Of(Gf.CreateLineString(new[] { new Coordinate(work.Lon, work.Lat), new Coordinate(-7.975, 41.01), new Coordinate(tank.Lon, tank.Lat) }));
        var trip = new UnitDuty.Trip(road, Minutes: 8, StopMinutes: 6, "wp-1", "Charca", tank);
        var lpm = rules.Water.WorkingLpm(1000);
        var segments = UnitDuty.Plan(0, 120, new UnitDuty.Inputs(3000, lpm, trip, 16, 200, 200, 0.4, rules.Fuel.WorkingLph / 60, 50, null), rules.Crews).ToList();

        var toWater = segments.First(s => s.Phase == UnitDuty.Phase.ToWater);
        Assert.Equal(3000 / lpm, toWater.From, 3);                                           // sai quando a água acaba
        var halfway = UnitDuty.PositionAt(toWater, toWater.From + 4, work);
        Assert.True(halfway.Lat > 41.005);                                                   // vai pela estrada (pela curva a norte), não em linha reta
        var filling = segments.First(s => s.Phase == UnitDuty.Phase.Filling);
        Assert.Equal(tank, UnitDuty.PositionAt(filling, filling.From + 1, work));            // enche no ponto de água
        Assert.Equal(6, filling.To - filling.From, 3);
        var back = segments.First(s => s.Phase == UnitDuty.Phase.FromWater);
        Assert.Equal(3000, back.WaterTo);                                                    // volta cheia
        Assert.Equal(UnitDuty.Phase.Working, segments[segments.IndexOf(back) + 1].Phase);    // e volta a trabalhar no mesmo sítio
        Assert.True(back.FuelTo < toWater.FuelFrom);                                         // a viagem gasta combustível
    }

    [Fact]
    public void A_vehicle_low_on_fuel_goes_to_refuel_and_comes_back_full()
    {
        var rules = TestSettings.All.Rules;
        var work = new LatLon(41.0, -8.0);
        var pump = new LatLon(41.0, -7.9);
        var trip = new UnitDuty.Trip(RoutePath.Of(Gf.CreateLineString(new[] { new Coordinate(work.Lon, work.Lat), new Coordinate(pump.Lon, pump.Lat) })), 10, rules.Fuel.RefuelMinutes, "fac-1", "Posto", pump);
        // sem água (máquina de rasto, por exemplo) e com o depósito quase no limite: trabalha até ao limite e vai abastecer
        var segments = UnitDuty.Plan(0, 300, new UnitDuty.Inputs(0, 0, null, 16, 200, 60, 0.4, 0.2, 50, trip), rules.Crews).ToList();
        var toFuel = segments.First(s => s.Phase == UnitDuty.Phase.ToFuel);
        Assert.Equal((60 - 50) / 0.2, toFuel.From, 3);
        var fueling = segments.First(s => s.Phase == UnitDuty.Phase.Fueling);
        Assert.Equal(200, fueling.FuelTo);
        Assert.Equal(pump, UnitDuty.PositionAt(fueling, fueling.From, work));
        Assert.Equal(UnitDuty.Phase.Working, segments[segments.IndexOf(fueling) + 2].Phase);
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
