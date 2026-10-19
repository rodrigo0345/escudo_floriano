using System.Text.Json.Serialization;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record TerrainPoint(LatLon Position, double ElevationM, double SlopeDeg, double AspectDeg, VegetationAt? Vegetation, int Buildings, int EstimatedPeople,
    NearestRoad? NearestRoad, NearestWater? NearestWaterPoint, NearestPlace? NearestPlace);
