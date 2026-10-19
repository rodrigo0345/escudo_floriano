using FireTrace.ExternalData.Sources.Http;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Uma cena Sentinel-2 aberta: lê o NDVI de um ponto das bandas vermelha e infravermelha.</summary>
public sealed class Sentinel2Scene : IDisposable
{
    readonly Cog _red, _nir;

    Sentinel2Scene(Sentinel2SceneInfo info, Cog red, Cog nir) { Info = info; _red = red; _nir = nir; }

    public Sentinel2SceneInfo Info { get; }

    public static async Task<Sentinel2Scene> OpenAsync(HttpFetcher http, Sentinel2SceneInfo info)
    {
        var red = await Cog.OpenAsync(http, info.RedUrl);
        try { return new Sentinel2Scene(info, red, await Cog.OpenAsync(http, info.NirUrl)); }
        catch { red.Dispose(); throw; }
    }

    /// <summary>O NDVI do ponto, ou nada se a cena não o cobre (ou não tem dados lá).</summary>
    public float? NdviAt(double lat, double lon)
    {
        if (Info.PixelAt(lat, lon) is not var (col, row)) return null;
        return NdviMath.Compute(_red.Read(col, row), _nir.Read(col, row));
    }

    public void Dispose()
    {
        _red.Dispose();
        _nir.Dispose();
    }
}
