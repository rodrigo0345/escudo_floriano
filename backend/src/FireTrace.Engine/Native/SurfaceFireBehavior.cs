namespace FireTrace.Engine.Native;

/// <summary>
/// What a surface fire does in one cell at one moment, after Rothermel and the wind/slope vector combination: the rate of spread in the direction of
/// maximum spread, that direction, the length-to-width ratio of the ellipse, the fireline intensity and the flame length. SI units at the boundary.
/// </summary>
public readonly record struct SurfaceFireBehavior(
    double NoWindRosMPerMin,
    double MaxRosMPerMin,
    double DirectionDeg,
    double LengthToWidth,
    double IntensityKwm,
    double EffectiveWindMPerMin,
    double FlameLengthM)
{
    public static readonly SurfaceFireBehavior None = new(0, 0, 0, 1, 0, 0, 0);
}
