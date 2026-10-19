using NetTopologySuite.Geometries;

namespace FireTrace.ExternalData.Map;

/// <summary>A fábrica de geometrias em WGS84 (SRID 4326) partilhada por tudo o que cria geometrias NTS; é imutável.</summary>
internal static class Wgs84
{
    public static readonly GeometryFactory Factory = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
}
