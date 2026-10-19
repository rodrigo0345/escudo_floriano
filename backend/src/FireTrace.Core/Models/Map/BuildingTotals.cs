using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record BuildingTotals(long Buildings, long EstimatedPeople, double CellM);
