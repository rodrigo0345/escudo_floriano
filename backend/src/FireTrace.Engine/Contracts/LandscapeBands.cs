namespace FireTrace.Engine.Contracts;

/// <summary>
/// The layout of <see cref="FireJob.Landscape"/>: eight Int16 bands stored one after another (band-sequential), each `CellCount` long, row 0 = north.
/// Both the code that builds the landscape and every engine read it through these indexes.
/// </summary>
public static class LandscapeBands
{
    public const int Elevation = 0;
    public const int Slope = 1;
    public const int Aspect = 2;
    /// <summary>Scott &amp; Burgan fuel model (fbfm40).</summary>
    public const int Fuel = 3;
    public const int CanopyCover = 4;
    /// <summary>Canopy height in decimetres.</summary>
    public const int CanopyHeight = 5;
    /// <summary>Canopy base height in decimetres.</summary>
    public const int CanopyBase = 6;
    /// <summary>Canopy bulk density in hundredths of kg/m³.</summary>
    public const int CanopyBulkDensity = 7;
    public const int Count = 8;

    public static short At(short[] bands, int cellCount, int band, int cell) => bands[band * cellCount + cell];
}
