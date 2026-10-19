using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>A geometria dos tiles WorldCover: qual tile cobre o local e que píxeis desse tile o cobrem.</summary>
public static class WorldCoverTiling
{
    /// <summary>Um tile de <c>deg</c> graus: o nome no ficheiro e o canto sudoeste.</summary>
    public sealed record Tile(string Name, int Lat0, int Lon0);

    /// <summary>Os píxeis <c>[Xa, Xb) × [Ya, Yb)</c> de um tile que cobrem o local, e a extensão geográfica exata dessa janela.</summary>
    public sealed record Window(int Xa, int Xb, int Ya, int Yb, GeoBounds Extent)
    {
        public int Width => Xb - Xa;
        public int Height => Yb - Ya;
    }

    public static Tile Locate(GeoBounds b, int deg)
    {
        int lat0 = (int)Math.Floor(b.South / deg) * deg, lon0 = (int)Math.Floor(b.West / deg) * deg;
        if ((int)Math.Floor(b.North / deg) * deg != lat0 || (int)Math.Floor(b.East / deg) * deg != lon0)
            throw new NotSupportedException($"O local cruza dois tiles WorldCover de {deg}°; ainda não suportado.");
        return new Tile($"{(lat0 >= 0 ? "N" : "S")}{Math.Abs(lat0):00}{(lon0 >= 0 ? "E" : "W")}{Math.Abs(lon0):000}", lat0, lon0);
    }

    /// <summary>A janela do tile (de <paramref name="tileWidth"/> × <paramref name="tileHeight"/> píxeis) que cobre <paramref name="b"/>.</summary>
    public static Window WindowOf(GeoBounds b, Tile tile, int deg, int tileWidth, int tileHeight)
    {
        double px = (double)deg / tileWidth, py = (double)deg / tileHeight;
        int xa = (int)Math.Floor((b.West - tile.Lon0) / px), xb = (int)Math.Ceiling((b.East - tile.Lon0) / px);
        int ya = (int)Math.Floor((tile.Lat0 + deg - b.North) / py), yb = (int)Math.Ceiling((tile.Lat0 + deg - b.South) / py);
        return new Window(xa, xb, ya, yb, new GeoBounds(tile.Lat0 + deg - yb * py, tile.Lon0 + xa * px, tile.Lat0 + deg - ya * py, tile.Lon0 + xb * px));
    }
}
