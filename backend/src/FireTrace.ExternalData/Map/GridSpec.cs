namespace FireTrace.ExternalData.Map;

/// <summary>Grelha regular local (equirretangular): célula (x,y) com y=0 a norte; centros de célula em coordenadas inteiras.</summary>
public sealed class GridSpec
{
    public int Width { get; }
    public int Height { get; }
    public double CellM { get; }
    public double LatNorth { get; }
    public double LonWest { get; }
    public double DLat { get; }
    public double DLon { get; }

    public GridSpec(double centerLat, double centerLon, int width, int height, double cellM)
    {
        Width = width; Height = height; CellM = cellM;
        DLat = cellM / 111320.0;
        DLon = cellM / (111320.0 * Math.Cos(centerLat * Math.PI / 180));
        LatNorth = centerLat + height / 2.0 * DLat;
        LonWest = centerLon - width / 2.0 * DLon;
    }

    public int CellCount => Width * Height;
    public GeoBounds Bounds => new(LatNorth - Height * DLat, LonWest, LatNorth, LonWest + Width * DLon);
    public (double X, double Y) ToCell(double lat, double lon) => ((lon - LonWest) / DLon - 0.5, (LatNorth - lat) / DLat - 0.5);
    public (double Lat, double Lon) ToLatLon(double x, double y) => (LatNorth - (y + 0.5) * DLat, LonWest + (x + 0.5) * DLon);
    public bool Inside(double x, double y) => x >= -0.5 && y >= -0.5 && x <= Width - 0.5 && y <= Height - 0.5;
    public int Index(int x, int y) => y * Width + x;

    /// <summary>Índice da célula que contém o ponto, ou -1 se estiver fora da grelha.</summary>
    public int CellAt(double lat, double lon)
    {
        var (x, y) = ToCell(lat, lon);
        int cx = (int)Math.Round(x), cy = (int)Math.Round(y);
        return cx < 0 || cy < 0 || cx >= Width || cy >= Height ? -1 : cy * Width + cx;
    }
}
