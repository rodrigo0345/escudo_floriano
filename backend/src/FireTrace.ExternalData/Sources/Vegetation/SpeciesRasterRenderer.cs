using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Raster fino de classes de combustível (ids do FuelCatalog) alinhado com a área, para a vista "tipos de árvores".</summary>
public static class SpeciesRasterRenderer
{
    /// <summary>Píxeis RGBA de <paramref name="outPx"/> × <paramref name="outPx"/> sobre a área da grelha: o canal R é o id da classe (PNG sem perdas).</summary>
    public static byte[] Render(SpeciesMap map, GridSpec spec, int outPx)
    {
        var b = spec.Bounds;
        var ext = map.Extent;
        int ww = map.FineWidth, hh = map.FineHeight;
        var rgba = new byte[outPx * outPx * 4];
        for (int j = 0; j < outPx; j++)
        {
            double lat = b.North - (j + 0.5) / outPx * (b.North - b.South);
            int sy = Math.Clamp((int)((ext.North - lat) / (ext.North - ext.South) * hh), 0, hh - 1);
            for (int i = 0; i < outPx; i++)
            {
                double lon = b.West + (i + 0.5) / outPx * (b.East - b.West);
                int sx = Math.Clamp((int)((lon - ext.West) / (ext.East - ext.West) * ww), 0, ww - 1);
                int o = (j * outPx + i) * 4;
                rgba[o] = map.Fine[sy * ww + sx]; rgba[o + 3] = 255; // R = id da classe (PNG sem perdas)
            }
        }
        return rgba;
    }
}
