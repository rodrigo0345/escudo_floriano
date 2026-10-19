using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record BuildingCollection(IReadOnlyList<Feature<BuildingProperties>> Features, BuildingTotals Totals, double PeoplePerBuilding) { public string Type => "FeatureCollection"; }
