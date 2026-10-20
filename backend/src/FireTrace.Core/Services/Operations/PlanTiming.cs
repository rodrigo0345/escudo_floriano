using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans.Triggers;

namespace FireTrace.Core.Services.Operations;

/// <summary>Quando começa uma ação: o gatilho de hora conta desde o início do horizonte do plano; sem gatilho de hora, ao ativar (minuto 0).</summary>
public static class PlanTiming
{
    public static double StartMinutes(Plan plan, PlanAction a) => a.Trigger is AtTimeTrigger t ? t.At.Time is { } abs ? (abs - (plan.Horizon?.Start ?? abs)).TotalMinutes : t.At.OffsetMinutes ?? 0 : 0;

    /// <summary>O instante em que a ação começa, se o plano tem horizonte.</summary>
    public static DateTimeOffset? StartAt(Plan plan, PlanAction a) => plan.Horizon?.Start.AddMinutes(StartMinutes(plan, a));
}
