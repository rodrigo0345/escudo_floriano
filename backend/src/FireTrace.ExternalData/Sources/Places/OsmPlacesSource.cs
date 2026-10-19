using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Places;

/// <summary>Localidades e instalações do OSM: serviços de emergência e, para as evacuações, escolas, lares, abrigos, campismo e combustíveis.</summary>
public sealed class OsmPlacesSource(OverpassClient overpass, OverpassOptions overpassOptions, PlaceOptions places)
{
    public async Task<(List<Place> Places, List<Facility> Facilities)> FetchAsync(GridSpec spec)
    {
        var prefix = overpass.Prefix(overpassOptions.PlacesQueryTimeoutSeconds);
        var bb = OverpassBbox.Of(spec.Bounds);
        using var core = await overpass.QueryAsync(PlaceQueries.Core(prefix, bb));
        using var civil = await overpass.QueryAsync(PlaceQueries.Civil(prefix, bb));
        return OsmPlaceParser.Parse(OsmJson.Elements(core).Concat(OsmJson.Elements(civil)), spec, places);
    }
}
