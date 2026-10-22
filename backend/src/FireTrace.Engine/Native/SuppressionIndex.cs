using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Native;

/// <summary>The suppression windows of a job indexed by cell, so the solver can ask "how much is the spread of cell `c` held back at minute `t`?" in O(windows on that cell).</summary>
public sealed class SuppressionIndex
{
    static readonly SuppressionIndex None = new(null, 0, 0, 1, 0, 0, 2);
    readonly (float From, float Until, float Effectiveness, bool Direct)[]?[]? _byCell;
    readonly double _full, _none, _min, _lineFull, _lineBreach, _extinguish;

    SuppressionIndex((float, float, float, bool)[]?[]? byCell, double full, double none, double min, double lineFull, double lineBreach, double extinguish)
    {
        _byCell = byCell; _full = full; _none = none; _min = min; _lineFull = lineFull; _lineBreach = lineBreach; _extinguish = extinguish;
    }

    public static SuppressionIndex Of(SuppressionPlan? plan, int cellCount)
    {
        if (plan is null || plan.Windows.Count == 0) return None;
        var lists = new List<(float, float, float, bool)>?[cellCount];
        foreach (var w in plan.Windows)
            foreach (int c in w.Cells)
                if (c >= 0 && c < cellCount) (lists[c] ??= new()).Add((w.FromMinute, w.UntilMinute, w.Effectiveness, w.Direct));
        return new SuppressionIndex(lists.Select(l => l?.ToArray()).ToArray(), plan.FullKwm, plan.NoneKwm, plan.MinFactor, plan.LineHoldFullKwm, plan.LineBreachKwm, plan.ExtinguishAt);
    }

    /// <summary>
    /// The fraction of the normal spread that is left (1 = nobody is working here). `intensityKwm` is the fireline intensity of the fire coming into the cell, in
    /// the direction it comes (the solver scales the source's head intensity by the spread ellipse: a flank or a backing fire is a fraction of the head).
    /// </summary>
    public double Factor(int cell, float minute, double intensityKwm)
    {
        if (_byCell?[cell] is not { } windows) return 1;
        double factor = 1, left = 1; // `left`: what the direct attack on the cell leaves of the fire
        foreach (var (from, until, effectiveness, direct) in windows)
        {
            if (minute < from || minute >= until) continue;
            if (direct)
            {
                double stop = Math.Clamp(effectiveness * DirectPower(intensityKwm), 0, 0.98);
                factor *= 1 - stop;
                left *= 1 - stop;
                continue;
            }
            // A control line is a barrier, not a slower band: where it holds the fire stops (down to `MinFactor`), where it is breached the fire goes on.
            // `effectiveness` is how likely it is to hold a fire it can hold; the time to cross is the average of the two, so the rate is its harmonic mean.
            double hold = Math.Clamp(effectiveness * LinePower(intensityKwm), 0, 0.98);
            factor *= 1 / (hold / _min + (1 - hold));
        }
        if (intensityKwm <= _full && 1 - left >= _extinguish) return 0; // enough crews on flames they can fight: the fire does not get in
        return Math.Max(_min, factor);
    }

    /// <summary>Direct attack: full below `FullKwm`, nothing from `NoneKwm` on (hand crews and engines cannot work a fire that fierce), linear in between.</summary>
    double DirectPower(double intensityKwm) => intensityKwm <= _full ? 1 : intensityKwm >= _none ? 0 : (_none - intensityKwm) / (_none - _full);

    /// <summary>A finished line: holds in full below `LineHoldFullKwm`, is breached from `LineBreachKwm` on, linear in between.</summary>
    double LinePower(double intensityKwm) =>
        intensityKwm <= _lineFull ? 1 : intensityKwm >= _lineBreach ? 0 : (_lineBreach - intensityKwm) / (_lineBreach - _lineFull);
}
