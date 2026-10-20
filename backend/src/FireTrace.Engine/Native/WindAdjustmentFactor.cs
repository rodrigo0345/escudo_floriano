namespace FireTrace.Engine.Native;

/// <summary>
/// The midflame wind adjustment factor (Andrews 2012, the same equation Behave+ and ELMFIRE use for the 20-ft wind):
/// an open fuel bed uses its depth, a sheltered one uses canopy cover and height. For the patchy Mediterranean canopies of Guimarães the two are
/// blended by cover, because the standard sheltered equation assumes a continuous crown.
/// </summary>
public static class WindAdjustmentFactor
{
    /// <summary>Fraction of the 20-ft wind that reaches the fuel bed; `min` is a floor for very sparse or unresolved canopies.</summary>
    public static double Of(double fuelDepthFt, double canopyHeightFt, double canopyCover, double min = 0)
    {
        double open = fuelDepthFt > 0
            ? 1.83 / Math.Log((20.0 + 0.36 * fuelDepthFt) / (0.13 * fuelDepthFt))
            : 0;
        double cover = Math.Clamp(canopyCover, 0, 1);
        double value = open;
        if (cover > 0 && canopyHeightFt >= 6 && open > 0)
        {
            double crownFill = cover / 3.0;
            double a = Math.Sqrt(crownFill * canopyHeightFt);
            double b = Math.Log((20.0 + 0.36 * canopyHeightFt) / (0.13 * canopyHeightFt));
            double sheltered = 0.555 / (a * b);
            value = open * (1 - cover) + sheltered * cover;
        }
        return Math.Max(min, Math.Max(0.01, value));
    }
}
