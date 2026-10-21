namespace FireTrace.Engine.Native;

/// <summary>
/// What the fire does in one cell at one moment: the fastest spread (m/min) and where it points, the ellipse that shapes every other direction,
/// the fireline intensity used to decide whether crews can attack it, and whether it has started to burn the canopy.
/// </summary>
public readonly record struct CellBehavior(double MaxRosMPerMin, double DirectionDeg, double LengthToWidth, double IntensityKwm, bool Crown, bool ActiveCrown)
{
    public static readonly CellBehavior None = new(0, 0, 1, 0, false, false);
}
