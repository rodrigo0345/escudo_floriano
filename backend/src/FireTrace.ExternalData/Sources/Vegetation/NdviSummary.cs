namespace FireTrace.ExternalData.Sources.Vegetation;

public static class NdviSummary
{
    /// <summary>Os percentis (p5…p95) do NDVI de inverno e da amplitude verão-inverno, só dos píxeis com dados nas duas estações.</summary>
    public static (string Winter, string Amplitude) Percentiles(float[] winter, float[] summer)
    {
        var amp = new List<float>(); var win = new List<float>();
        for (int i = 0; i < winter.Length; i++)
            if (!float.IsNaN(winter[i]) && !float.IsNaN(summer[i])) { win.Add(winter[i]); amp.Add(summer[i] - winter[i]); }
        amp.Sort(); win.Sort();
        return (Describe(win), Describe(amp));
    }

    static string Describe(List<float> sorted) => string.Join(" ", new[] { 5, 25, 50, 75, 95 }.Select(q => $"p{q}={sorted[sorted.Count * q / 100]:F2}"));
}
