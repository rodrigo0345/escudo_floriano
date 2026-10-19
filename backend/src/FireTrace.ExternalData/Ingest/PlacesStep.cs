using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Sources.Places;
using FireTrace.ExternalData.Store;

namespace FireTrace.ExternalData.Ingest;

/// <summary>Localidades e instalações: as do OSM mais as curadas à mão no ficheiro do local (que prevalecem).</summary>
public sealed class PlacesStep(OsmPlacesSource osmPlaces, PlaceOptions options, IMapWriter writer, IIngestLog log) : IIngestStep
{
    public string Name => "places";
    public int Order => 70;

    public async Task RunAsync(IngestContext ctx)
    {
        var (places, osmFacilities) = await osmPlaces.FetchAsync(ctx.Spec);
        var facilities = CuratedFacilityMerger.Merge(osmFacilities, ctx.Location.CuratedFacilities, options.CuratedDedupeDegrees);
        log.Info($"  {places.Count} localidades; instalações: " + string.Join(", ", facilities.GroupBy(f => f.Kind).Select(g => $"{g.Key}={g.Count()}")));
        await writer.ReplacePlacesAsync(ctx.Id, places);
        await writer.ReplaceFacilitiesAsync(ctx.Id, facilities);
    }
}
