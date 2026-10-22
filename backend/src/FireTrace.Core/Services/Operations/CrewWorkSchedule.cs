using FireTrace.Core.Domain.Rules;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// Quando é que uma equipa está mesmo a combater: com água para `water / (min(bomba, attackFlowLpm) × dutyCycle)` minutos e depois a ir reabastecer (`shuttle + setup`), a cansar-se
/// (`fatiguePctPerHour`, até à eficácia mínima) e a ter de descansar depois de `maxContinuousWorkMinutes`. Uma viatura sem água (ou sem bomba) trabalha sem pausas de reabastecimento.
/// </summary>
public static class CrewWorkSchedule
{
    /// <param name="Fatigue">Fração da eficácia que a equipa ainda tem (1 = descansada).</param>
    public sealed record Segment(double FromMinute, double Minutes, double Fatigue);

    public static IReadOnlyList<Segment> Plan(double arrival, double until, double waterL, double pumpLpm, Rules rules)
    {
        double duty = rules.Water.DutyCycle, gap = rules.Water.Refill.ShuttleMinutes + rules.Water.Refill.SetupMinutes;
        double floor = rules.Crews.MinimumEffectivenessPct / 100;
        double lpm = rules.Water.WorkingLpm(pumpLpm);
        double perFill = waterL > 0 && lpm > 0 && duty > 0 ? waterL / lpm : double.PositiveInfinity;
        var segments = new List<Segment>();
        double t = arrival, worked = 0;
        while (t < until - 1e-9)
        {
            double span = Math.Min(Math.Min(perFill, until - t), Math.Max(0, rules.Crews.MaxContinuousWorkMinutes - worked));
            if (span <= 1e-9) { t += rules.Crews.MandatoryRestMinutes; worked = 0; continue; } // descansa e volta de novo descansada
            double fatigue = Math.Max(floor, 1 - rules.Crews.FatiguePctPerHour / 100 * (worked + span / 2) / 60);
            segments.Add(new Segment(t, span, fatigue));
            t += span; worked += span;
            if (double.IsFinite(perFill) && span >= perFill - 1e-9) t += gap; // sem água: vai reabastecer
        }
        return segments;
    }
}
