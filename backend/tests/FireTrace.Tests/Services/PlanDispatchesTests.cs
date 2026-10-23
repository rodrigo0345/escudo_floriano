using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans.Triggers;
using FireTrace.Core.Services.Operations;

namespace FireTrace.Tests.Services;

/// <summary>Activation makes one dispatch per unit: tasks a unit chains share it, tasks at the same time still conflict.</summary>
public class PlanDispatchesTests
{
    static readonly DateTimeOffset Start = new(2026, 8, 17, 15, 0, 0, TimeSpan.Zero);

    static FireAttackAction Task(string id, ResourceAssignment unit, int? at = null, int stay = 60, string? after = null) => new()
    {
        Id = id, Title = id, OrganizationId = "org-1", Tactic = "direct", ExpectedDurationMinutes = stay,
        Trigger = after is not null ? new OnActionCompleteTrigger(after) : at is { } m ? new AtTimeTrigger(new TimeSpec(OffsetMinutes: m)) : null,
        DependsOn = after is null ? null : new() { after },
        Resources = new() { unit },
    };

    static ResourceAssignment Vehicle(string id, int? personnel = 5, double eta = 10) => new(ResourceType.Vehicle, id, personnel, EtaMinutes: eta);
    static ResourceAssignment Pool(string id, int personnel) => new(ResourceType.PersonnelPool, id, personnel);

    static List<(PlanAction Action, ResourceAssignment Resource, int StayMinutes)> Build(params PlanAction[] actions) =>
        PlanDispatches.Build(new Plan { LocationId = "loc", Title = "Plano", Actions = actions.ToList(), Horizon = new PlanHorizon(Start, Start.AddHours(6)) }, 30, _ => 3);

    [Fact]
    public void A_vehicle_that_attacks_and_then_holds_is_one_dispatch_to_its_first_task_for_the_whole_time()
    {
        var d = Assert.Single(Build(Task("attack", Vehicle("v1")), Task("hold", Vehicle("v1", eta: 0), at: 70, stay: 100)));
        Assert.Equal("attack", d.Action.Id);
        Assert.Equal(160, d.StayMinutes); // arrives at 10, attacks until 70, holds until 170
    }

    [Fact]
    public void A_reserve_drawn_on_by_a_later_order_is_one_dispatch_the_wait_ends_with_the_new_order()
    {
        var reserve = new StageResourcesAction
        {
            Id = "reserve", Title = "reserve", OrganizationId = "org-1", ExpectedDurationMinutes = 200, StagingArea = new Target(Label: "staging"), Resources = new() { Vehicle("v1") },
        };
        var d = Assert.Single(Build(reserve, Task("wave", Vehicle("v1"), at: 120, stay: 60)));
        Assert.Equal("reserve", d.Action.Id);
    }

    [Fact]
    public void A_hold_timed_a_minute_before_the_job_ends_starts_when_the_job_ends()
    {
        var hold = new StageResourcesAction
        {
            Id = "hold", Title = "hold", OrganizationId = "org-1", ExpectedDurationMinutes = 24, StagingArea = new Target(Label: "here"),
            Trigger = new AtTimeTrigger(new TimeSpec(OffsetMinutes: 216)), Resources = new() { Vehicle("v1", eta: 3.1) },
        };
        Assert.Single(Build(Task("attack", Vehicle("v1", eta: 3.1), stay: 214), hold)); // the attack ends at 217.1
    }

    [Fact]
    public void A_later_order_re_tasks_a_vehicle_on_the_road_one_dispatch_that_follows_the_new_order()
    {
        // a wave at T+150 puts in a reserve a tanker still driving to its T+120 attack (90 min away): the later order wins
        var reserve = new StageResourcesAction
        {
            Id = "reserve", Title = "reserve", OrganizationId = "org-1", ExpectedDurationMinutes = 30, StagingArea = new Target(Label: "staging"),
            Trigger = new AtTimeTrigger(new TimeSpec(OffsetMinutes: 150)), Resources = new() { Vehicle("v1", eta: 70) },
        };
        Assert.Single(Build(Task("attack", Vehicle("v1", eta: 90), at: 120, stay: 240), reserve));
    }

    [Fact]
    public void A_vehicle_in_two_tasks_that_start_together_stays_two_dispatches_so_the_conflict_is_reported()
    {
        Assert.Equal(2, Build(Task("a", Vehicle("v1")), Task("b", Vehicle("v1"))).Count);
    }

    [Fact]
    public void A_group_that_evacuates_and_then_attacks_lends_its_people_once_starting_with_the_evacuation()
    {
        // the attack has no time of its own: it waits for the evacuation (listed first here on purpose)
        var d = Assert.Single(Build(Task("attack", Pool("p1", 75), after: "evac"), Task("evac", Pool("p1", 75), stay: 80)));
        Assert.Equal("evac", d.Action.Id);
        Assert.Equal(75, d.Resource.Personnel);
    }

    [Fact]
    public void A_group_in_two_tasks_at_the_same_time_lends_the_people_of_both()
    {
        var d = Assert.Single(Build(Task("a", Pool("p1", 5)), Task("b", Pool("p1", 3), at: 20)));
        Assert.Equal(8, d.Resource.Personnel);
    }

    [Fact]
    public void A_vehicle_without_a_headcount_takes_its_crew_not_one_person()
    {
        Assert.Equal(3, Assert.Single(Build(Task("a", Vehicle("heli", personnel: null)))).Resource.Personnel);
    }
}
