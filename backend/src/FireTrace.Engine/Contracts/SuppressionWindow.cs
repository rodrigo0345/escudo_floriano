namespace FireTrace.Engine.Contracts;

/// <summary>
/// Firefighting over time: inside `Cells` the fire spreads slower by `Effectiveness` (0–1) while its front is there between `FromMinute` and `UntilMinute`
/// (minutes since the scenario start). `Direct` windows are crews and drops working the flames, so they lose power as the fireline intensity rises;
/// the others (a finished fire line) are barriers that do not care.
/// </summary>
public sealed record SuppressionWindow(int[] Cells, float FromMinute, float UntilMinute, float Effectiveness, bool Direct = true);
