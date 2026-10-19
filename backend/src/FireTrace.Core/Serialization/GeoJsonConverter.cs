using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Serialization;

/// <summary>Lê e escreve geometrias NTS como GeoJSON (RFC 7946); `[lon, lat]`, WGS84.</summary>
public sealed class GeoJsonConverter : JsonConverter<Geometry>
{
    public override bool CanConvert(Type t) => typeof(Geometry).IsAssignableFrom(t);

    public override Geometry? Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        return FireTrace.ExternalData.Map.GeoJson.Parse(doc.RootElement);
    }

    public override void Write(Utf8JsonWriter writer, Geometry value, JsonSerializerOptions options) => FireTrace.ExternalData.Map.GeoJson.Write(writer, value);
}
