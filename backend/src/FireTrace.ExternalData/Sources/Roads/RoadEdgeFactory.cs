using System.Globalization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Roads;

public static class RoadEdgeFactory
{
    /// <summary>Um troço entre dois cruzamentos com as etiquetas da via OSM a que pertence.</summary>
    public static RoadEdge Create(int id, JsonElement way, string a, string b, double[] flat, double length, GridSpec spec)
    {
        var hw = OsmJson.Tag(way, "highway") ?? "";
        var tracktype = OsmJson.Tag(way, "tracktype");
        // só os caminhos de terra ou de qualidade desconhecida exigem viatura todo-o-terreno
        bool offRoad = hw == "track" && tracktype is not ("grade1" or "grade2");
        double? width = double.TryParse(OsmJson.Tag(way, "width"), NumberStyles.Float, CultureInfo.InvariantCulture, out var w) ? w : null;
        return new RoadEdge(id, OsmJson.Tag(way, "name") ?? OsmJson.Tag(way, "ref") ?? $"via ({hw})", OsmJson.Tag(way, "ref") ?? "", hw, a, b, flat,
            RoadGeometry.CellsOf(flat, spec), length, offRoad, tracktype, width);
    }
}
