namespace FireTrace.ExternalData.Map;

/// <summary>Grelhas por célula do local: relevo, uso do solo (classe de vegetação) e nº de edifícios.</summary>
public sealed class TerrainGrids
{
    public GridSpec Spec { get; }
    public float[] Elevation { get; }
    public byte[] LandCover { get; }
    public ushort[] Buildings { get; }
    readonly Lazy<(float[] Slope, float[] Aspect)> _slopeAspect;

    public TerrainGrids(GridSpec spec, float[] elevation, byte[] landCover, ushort[] buildings)
    {
        Spec = spec; Elevation = elevation; LandCover = landCover; Buildings = buildings;
        _slopeAspect = new(Horn);
    }

    /// <summary>Declive em graus.</summary>
    public float[] Slope => _slopeAspect.Value.Slope;
    /// <summary>Exposição em graus (convenção LANDFIRE): para onde a encosta desce.</summary>
    public float[] Aspect => _slopeAspect.Value.Aspect;

    /// <summary>Horn 3×3: derivadas para este e para sul (y cresce para sul).</summary>
    (float[], float[]) Horn()
    {
        int w = Spec.Width, h = Spec.Height; double cell = Spec.CellM;
        var slope = new float[w * h]; var aspect = new float[w * h];
        double E(int x, int y) => Elevation[Math.Clamp(y, 0, h - 1) * w + Math.Clamp(x, 0, w - 1)];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                double dzdx = ((E(x + 1, y - 1) + 2 * E(x + 1, y) + E(x + 1, y + 1)) - (E(x - 1, y - 1) + 2 * E(x - 1, y) + E(x - 1, y + 1))) / (8 * cell);
                double dzds = ((E(x - 1, y + 1) + 2 * E(x, y + 1) + E(x + 1, y + 1)) - (E(x - 1, y - 1) + 2 * E(x, y - 1) + E(x + 1, y - 1))) / (8 * cell);
                double s = Math.Atan(double.Hypot(dzdx, dzds)) * 180 / Math.PI;
                slope[y * w + x] = (float)s;
                aspect[y * w + x] = s < 0.5 ? 0 : (float)((Math.Atan2(-dzdx, dzds) * 180 / Math.PI + 360) % 360);
            }
        return (slope, aspect);
    }
}
