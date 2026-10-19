namespace FireTrace.ExternalData.Sources.Projection;

/// <summary>Web Mercator (EPSG:3857): coordenadas de tile (esquema XYZ) e metros.</summary>
public static class WebMercator
{
    const double Radius = 20037508.342789244; // raio da esfera de Web Mercator (EPSG:3857), constante geodésica

    /// <summary>Posição fracionária no esquema de tiles XYZ do nível <paramref name="zoom"/> (cada tile tem 256 px).</summary>
    public static (double X, double Y) TileCoordinates(double lat, double lon, int zoom) =>
        ((lon + 180) / 360 * (1 << zoom), (1 - Math.Asinh(Math.Tan(lat * Math.PI / 180)) / Math.PI) / 2 * (1 << zoom));

    public static (double X, double Y) Metres(double lat, double lon) =>
        (lon * Radius / 180, Math.Log(Math.Tan((90 + lat) * Math.PI / 360)) * Radius / Math.PI);
}
