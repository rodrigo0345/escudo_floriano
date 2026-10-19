using FireTrace.ExternalData.Map;

namespace FireTrace.ExternalData.Ingest;

public static class CuratedFacilityMerger
{
    /// <summary>
    /// Junta as instalações curadas à mão às do OSM. As curadas prevalecem: tiram as do OSM do mesmo tipo a menos de <paramref name="dedupeDegrees"/> de distância
    /// e entram com confiança total.
    /// </summary>
    public static List<Facility> Merge(IEnumerable<Facility> osm, IEnumerable<CuratedFacility> curated, double dedupeDegrees)
    {
        var facilities = osm.ToList();
        foreach (var cf in curated)
        {
            var kind = EnumText.Parse<FacilityKind>(cf.Type);
            facilities.RemoveAll(f => f.Kind == kind && Math.Abs(f.Lat - cf.Lat) < dedupeDegrees && Math.Abs(f.Lon - cf.Lon) < dedupeDegrees);
            facilities.Add(new Facility(0, kind, cf.Name, cf.Lat, cf.Lon, cf.Operator, cf.Source, 1.0));
        }
        return facilities;
    }
}
