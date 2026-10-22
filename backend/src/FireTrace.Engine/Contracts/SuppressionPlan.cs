namespace FireTrace.Engine.Contracts;

/// <summary>
/// All the suppression of a job. Direct attack works in full up to `FullKwm` of fireline intensity and not at all from `NoneKwm` on (linear in between);
/// the spread never drops below `MinFactor` of what it would be. A finished control line (an indirect window) holds the fire that reaches it, unless that fire
/// is too intense for it: it holds in full up to `LineHoldFullKwm` and is breached from `LineBreachKwm` on (flames taller than the line is wide, spotting over it).
/// Where the direct attack working a cell adds up to `ExtinguishAt` or more (1 - the product of what each window leaves) and the flames it faces are within `FullKwm`, the fire is put out there:
/// it does not enter the cell from that side (a value above 1 turns this off).
/// The intensity is always the one the fire has in the direction it spreads into the cell: a flank is far weaker than the head.
/// </summary>
public sealed record SuppressionPlan(IReadOnlyList<SuppressionWindow> Windows, double FullKwm, double NoneKwm, double MinFactor, double LineHoldFullKwm = 3500, double LineBreachKwm = 10000, double ExtinguishAt = 2);
