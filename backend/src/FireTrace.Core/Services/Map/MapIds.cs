using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Map;

/// <summary>Os ids dos dados do mapa são números na base de dados; na API têm prefixo (`rd-12`, `wp-3`).</summary>
public static class MapIds
{
    public static string Road(int id) => $"rd-{id}";
    public static string Place(long id) => $"pl-{id}";
    public static string Facility(long id) => $"fac-{id}";
    public static string Water(long id) => $"wp-{id}";
    public static string Firebreak(long id) => $"fb-{id}";

    public static int? RoadNumber(string? id) => id is not null && id.StartsWith("rd-") && int.TryParse(id[3..], out var n) ? n : null;
}
