namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>As cenas de uma estação: o NDVI de um ponto vem da primeira cena que tem dados nele.</summary>
public sealed class Sentinel2NdviSampler(IReadOnlyList<Sentinel2Scene> scenes) : IDisposable
{
    public int Count => scenes.Count;
    public IEnumerable<string> Ids => scenes.Select(s => s.Info.Id);

    /// <summary>O NDVI do ponto, ou NaN onde nenhuma cena tem dados.</summary>
    public float Sample(double lat, double lon)
    {
        foreach (var scene in scenes)
            if (scene.NdviAt(lat, lon) is { } ndvi) return ndvi;
        return float.NaN;
    }

    public void Dispose()
    {
        foreach (var scene in scenes) scene.Dispose();
    }
}
