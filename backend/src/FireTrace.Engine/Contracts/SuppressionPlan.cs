namespace FireTrace.Engine.Contracts;

/// <summary>
/// All the suppression of a job. Direct attack works in full up to `FullKwm` of fireline intensity and not at all from `NoneKwm` on (linear in between);
/// the spread never drops below `MinFactor` of what it would be.
/// </summary>
public sealed record SuppressionPlan(IReadOnlyList<SuppressionWindow> Windows, double FullKwm, double NoneKwm, double MinFactor);
