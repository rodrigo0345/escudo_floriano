using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Overpass;

public static class GridBlockSplitter
{
    /// <summary>Divide o local em blocos quadrados de no máximo `maxBlockM` metros: áreas grandes falham ou expiram num único pedido.</summary>
    public static IEnumerable<GridBlock> Split(GridSpec spec, double maxBlockM)
    {
        var b = spec.Bounds;
        int parts = Math.Max(1, (int)Math.Ceiling(Math.Max(spec.Width, spec.Height) * spec.CellM / maxBlockM));
        for (int py = 0; py < parts; py++)
            for (int px = 0; px < parts; px++)
                yield return new GridBlock(py * parts + px + 1, parts * parts, new GeoBounds(
                    b.South + (b.North - b.South) * py / parts, b.West + (b.East - b.West) * px / parts,
                    b.South + (b.North - b.South) * (py + 1) / parts, b.West + (b.East - b.West) * (px + 1) / parts));
    }
}
