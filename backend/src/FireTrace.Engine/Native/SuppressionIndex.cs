using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Native;

/// <summary>The suppression windows of a job indexed by cell, so the solver can ask "how much is the spread of cell `c` held back at minute `t`?" in O(windows on that cell).</summary>
public sealed class SuppressionIndex
{
    static readonly SuppressionIndex None = new(null, 0, 0, 1);
    readonly (float From, float Until, float Effectiveness, bool Direct)[]?[]? _byCell;
    readonly double _full, _none, _min;

    SuppressionIndex((float, float, float, bool)[]?[]? byCell, double full, double none, double min) { _byCell = byCell; _full = full; _none = none; _min = min; }

    public static SuppressionIndex Of(SuppressionPlan? plan, int cellCount)
    {
        if (plan is null || plan.Windows.Count == 0) return None;
        var lists = new List<(float, float, float, bool)>?[cellCount];
        foreach (var w in plan.Windows)
            foreach (int c in w.Cells)
                if (c >= 0 && c < cellCount) (lists[c] ??= new()).Add((w.FromMinute, w.UntilMinute, w.Effectiveness, w.Direct));
        return new SuppressionIndex(lists.Select(l => l?.ToArray()).ToArray(), plan.FullKwm, plan.NoneKwm, plan.MinFactor);
    }

    /// <summary>The fraction of the normal spread that is left (1 = nobody is working here).</summary>
    public double Factor(int cell, float minute, double sourceIntensityKwm)
    {
        if (_byCell?[cell] is not { } windows) return 1;
        double factor = 1;
        foreach (var (from, until, effectiveness, direct) in windows)
        {
            if (minute < from || minute >= until) continue;
            double power = direct ? DirectPower(sourceIntensityKwm) : 1;
            factor *= 1 - Math.Clamp(effectiveness * power, 0, 0.98);
        }
        return Math.Max(_min, factor);
    }

    /// <summary>Direct attack: full below `FullKwm`, nothing from `NoneKwm` on (hand crews and engines cannot work a fire that fierce), linear in between.</summary>
    double DirectPower(double intensityKwm) => intensityKwm <= _full ? 1 : intensityKwm >= _none ? 0 : (_none - intensityKwm) / (_none - _full);
}
