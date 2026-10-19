using System.Text.Json;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans.Triggers;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Serialization;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Services;

public class DomainRuleTests
{
    [Theory]
    [InlineData(Responsibility.Firefighting, VehicleCapability.WildfireAttack, true)]
    [InlineData(Responsibility.Firefighting, VehicleCapability.TrafficControl, false)]
    [InlineData(Responsibility.TrafficControl, VehicleCapability.TrafficControl, true)]
    [InlineData(Responsibility.Standby, VehicleCapability.Lighting, true)]
    public void Responsibilities_need_matching_capabilities(Responsibility responsibility, VehicleCapability capability, bool expected) =>
        Assert.Equal(expected, TestSettings.Responsibilities.Supports(responsibility, new[] { capability }));

    [Fact]
    public void A_vehicle_without_declared_capabilities_can_do_anything() =>
        Assert.True(TestSettings.Responsibilities.Supports(Responsibility.Medical, null));

    [Fact]
    public void Time_specs_resolve_against_the_scenario_start()
    {
        var start = DateTimeOffset.Parse("2026-08-17T15:00:00Z");
        Assert.Equal(start.AddMinutes(-30), new TimeSpec(OffsetMinutes: -30).Resolve(start));
        Assert.Equal(DateTimeOffset.Parse("2026-08-17T18:00:00Z"), new TimeSpec(Time: DateTimeOffset.Parse("2026-08-17T18:00:00Z")).Resolve(start));
        Assert.Equal(180, new TimeSpec(Time: DateTimeOffset.Parse("2026-08-17T18:00:00Z")).MinutesFrom(start));
    }

    [Fact]
    public void Plan_actions_are_polymorphic_on_the_type_property_in_any_position()
    {
        var json = """{"title":"Cortar","organizationId":"org-1","id":"a-1","type":"road_closure","roadIds":["rd-1"],"kind":"full","reason":"fire_active","trigger":{"at":{"offsetMinutes":10},"kind":"at_time"}}""";
        var action = JsonSerializer.Deserialize<PlanAction>(json, ApiJson.Options);
        var closure = Assert.IsType<RoadClosureAction>(action);
        Assert.Equal(new[] { "rd-1" }, closure.RoadIds);
        Assert.IsType<AtTimeTrigger>(closure.Trigger);
        Assert.Contains("\"type\":\"road_closure\"", JsonSerializer.Serialize(action, ApiJson.Options));
    }
}
