using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

public static class UniformLandCover
{
    /// <summary>Um local sem dados de vegetação: toda a grelha na classe <paramref name="className"/> (`LandCover:UniformClass`).</summary>
    public static byte[] Create(GridSpec spec, string className) => Enumerable.Repeat(LandCover.IdOf(className), spec.Width * spec.Height).ToArray();
}
