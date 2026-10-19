using System.Text.Json.Serialization;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record GridInfo(int Width, int Height, double CellM, double DLat, double DLon, double LatNorth, double LonWest)
{
    public static GridInfo Of(GridSpec s) => new(s.Width, s.Height, s.CellM, s.DLat, s.DLon, s.LatNorth, s.LonWest);
}
