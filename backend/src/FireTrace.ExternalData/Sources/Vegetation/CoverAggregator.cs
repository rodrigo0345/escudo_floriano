using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

public static class CoverAggregator
{
    /// <summary>A classe mais frequente do raster fino (<paramref name="fineWidth"/> × <paramref name="fineHeight"/>) dentro de cada célula da grelha de simulação.</summary>
    public static byte[] Majority(byte[] fine, int fineWidth, int fineHeight, GridSpec spec)
    {
        int ww = fineWidth, hh = fineHeight;
        var cover = new byte[spec.Width * spec.Height];
        var counts = new int[LandCover.Count];
        for (int j = 0; j < spec.Height; j++)
            for (int i = 0; i < spec.Width; i++)
            {
                int y0 = j * hh / spec.Height, y1 = Math.Max((j + 1) * hh / spec.Height, y0 + 1), x0 = i * ww / spec.Width, x1 = Math.Max((i + 1) * ww / spec.Width, x0 + 1);
                Array.Clear(counts);
                for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) counts[fine[y * ww + x]]++;
                int best = 1; for (int c = 1; c < counts.Length; c++) if (counts[c] > counts[best]) best = c;
                cover[j * spec.Width + i] = (byte)best;
            }
        return cover;
    }
}
