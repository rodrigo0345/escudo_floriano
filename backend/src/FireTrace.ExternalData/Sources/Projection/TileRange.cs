using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Projection;

/// <summary>Os tiles XYZ (de 256 px) que cobrem uma área, com um tile de margem de cada lado; <see cref="MosaicWidth"/> × <see cref="MosaicHeight"/> é o mosaico que formam.</summary>
public readonly record struct TileRange(int X0, int X1, int Y0, int Y1)
{
    public const int TilePixels = 256;

    public int MosaicWidth => (X1 - X0 + 1) * TilePixels;
    public int MosaicHeight => (Y1 - Y0 + 1) * TilePixels;

    public static TileRange Covering(GeoBounds bounds, int zoom)
    {
        var (x0, y0) = WebMercator.TileCoordinates(bounds.North, bounds.West, zoom);
        var (x1, y1) = WebMercator.TileCoordinates(bounds.South, bounds.East, zoom);
        return new TileRange((int)x0 - 1, (int)x1 + 1, (int)y0 - 1, (int)y1 + 1);
    }
}
