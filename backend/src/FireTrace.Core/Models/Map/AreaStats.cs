using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record AreaStats(double AreaHa, int Buildings, int EstimatedPeople, IReadOnlyList<VegetationShare> Vegetation, ElevationStats ElevationM, double MeanSlopeDeg,
    IReadOnlyList<PlaceInArea> Places, IReadOnlyList<FacilityInArea> Facilities, RoadsInArea Roads, WaterInArea WaterPoints, FirebreaksInArea Firebreaks);
