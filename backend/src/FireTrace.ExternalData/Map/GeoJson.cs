using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Map;

/// <summary>Converte geometrias GeoJSON (RFC 7946: ponto, linha, polígono e as versões múltiplas) de e para geometrias NTS em WGS84.</summary>
public static class GeoJson
{
    public static Geometry Parse(JsonElement g)
    {
        var c = g.GetProperty("coordinates");
        return g.GetProperty("type").GetString() switch
        {
            "Point" => Wgs84.Factory.CreatePoint(Coord(c)),
            "MultiPoint" => Wgs84.Factory.CreateMultiPointFromCoords(c.EnumerateArray().Select(Coord).ToArray()),
            "LineString" => Wgs84.Factory.CreateLineString(Line(c)),
            "MultiLineString" => Wgs84.Factory.CreateMultiLineString(c.EnumerateArray().Select(l => Wgs84.Factory.CreateLineString(Line(l))).ToArray()),
            "Polygon" => Polygon(c),
            "MultiPolygon" => Wgs84.Factory.CreateMultiPolygon(c.EnumerateArray().Select(Polygon).ToArray()),
            var t => throw new NotSupportedException($"Geometria GeoJSON não suportada: {t}"),
        };
    }

    public static void Write(Utf8JsonWriter w, Geometry g)
    {
        w.WriteStartObject();
        w.WriteString("type", g.GeometryType);
        w.WritePropertyName("coordinates");
        Coordinates(w, g);
        w.WriteEndObject();
    }

    static void Coordinates(Utf8JsonWriter w, Geometry g)
    {
        switch (g)
        {
            case Point p: Pos(w, p.Coordinate); break;
            case LineString l: Ring(w, l.Coordinates); break;
            case Polygon pg:
                w.WriteStartArray(); Ring(w, pg.ExteriorRing.Coordinates);
                foreach (var h in pg.InteriorRings) Ring(w, h.Coordinates);
                w.WriteEndArray(); break;
            case GeometryCollection gc:
                w.WriteStartArray(); foreach (var part in gc.Geometries) Coordinates(w, part); w.WriteEndArray(); break;
            default: throw new NotSupportedException(g.GeometryType);
        }
    }

    static void Pos(Utf8JsonWriter w, Coordinate c) { w.WriteStartArray(); w.WriteNumberValue(Math.Round(c.X, 6)); w.WriteNumberValue(Math.Round(c.Y, 6)); w.WriteEndArray(); }
    static void Ring(Utf8JsonWriter w, Coordinate[] cs) { w.WriteStartArray(); foreach (var c in cs) Pos(w, c); w.WriteEndArray(); }

    static Coordinate Coord(JsonElement p) => new(p[0].GetDouble(), p[1].GetDouble());
    static Coordinate[] Line(JsonElement c) => c.EnumerateArray().Select(Coord).ToArray();

    static Polygon Polygon(JsonElement rings)
    {
        var all = rings.EnumerateArray().Select(r => Wgs84.Factory.CreateLinearRing(Line(r))).ToArray();
        return Wgs84.Factory.CreatePolygon(all[0], all.Skip(1).ToArray());
    }
}
