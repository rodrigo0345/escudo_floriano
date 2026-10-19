using FireTrace.ExternalData.Sources.Projection;

namespace FireTrace.ExternalData.Sources.Vegetation;

/// <summary>Uma cena Sentinel-2 L2A do catálogo: onde está e onde estão as bandas vermelha e infravermelha (COG em UTM, hemisfério norte).</summary>
public sealed record Sentinel2SceneInfo(string Id, string Tile, double X0, double Y0, double Res, int Zone, int Width, int Height, string RedUrl, string NirUrl)
{
    /// <summary>A coluna e a linha do píxel da cena que contém o ponto, ou nada se estiver fora da cena.</summary>
    public (int Col, int Row)? PixelAt(double lat, double lon)
    {
        var (x, y) = UtmProjection.Project(lat, lon, Zone);
        int col = (int)Math.Floor((x - X0) / Res), row = (int)Math.Floor((Y0 - y) / Res);
        return col < 0 || row < 0 || col >= Width || row >= Height ? null : (col, row);
    }
}
