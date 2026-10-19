namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Os códigos dos rasters de origem que interessam para separar as árvores por espécie.</summary>
public static class ForestCodes
{
    /// <summary>ESA WorldCover: árvores.</summary>
    public const byte WorldCoverTrees = 10;

    /// <summary>Copernicus HRL Forest Type: folhosas e coníferas (0 = sem floresta, 255 = sem dados).</summary>
    public const byte HrlBroadleaf = 1, HrlConifer = 2;
}
