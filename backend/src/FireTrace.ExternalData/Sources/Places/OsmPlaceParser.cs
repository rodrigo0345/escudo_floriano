using System.Text.Json;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Places;

public static class OsmPlaceParser
{
    /// <summary>Separa os elementos OSM em localidades e instalações dentro da grelha, sem instalações repetidas.</summary>
    public static (List<Place> Places, List<Facility> Facilities) Parse(IEnumerable<JsonElement> elements, GridSpec spec, PlaceOptions options)
    {
        var places = new List<Place>();
        var facilities = new List<Facility>();
        foreach (var el in elements)
        {
            var pos = OsmJson.Position(el);
            if (pos is null) continue;
            var (lat, lon) = pos.Value;
            if (spec.CellAt(lat, lon) < 0) continue;
            var name = OsmJson.Tag(el, "name");
            if (OsmJson.Tag(el, "place") is { } kind && name is not null)
            {
                bool estimated = !int.TryParse(OsmJson.Tag(el, "population"), out var pop);
                places.Add(new Place(0, name, kind, lat, lon, estimated ? options.DefaultPopulation[kind] : pop, estimated));
                continue;
            }
            var kindInfo = FacilityClassifier.Classify(el, name, options.Confidence);
            if (kindInfo is null) continue;
            var (fk, vulnerable, confidence) = kindInfo.Value;
            name ??= EnumText.ToSnake(fk);
            if (facilities.Any(f => f.Kind == fk && f.Name == name && Math.Abs(f.Lat - lat) < options.DedupeDegrees && Math.Abs(f.Lon - lon) < options.DedupeDegrees)) continue;
            int? capacity = int.TryParse(OsmJson.Tag(el, "capacity"), out var cap) ? cap : null;
            facilities.Add(new Facility(0, fk, name, lat, lon, OsmJson.Tag(el, "operator"), "osm", confidence, capacity, vulnerable));
        }
        return (PlaceDisambiguator.Apply(places), facilities);
    }
}
