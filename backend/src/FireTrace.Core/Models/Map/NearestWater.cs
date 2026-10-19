using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record NearestWater(string Id, string Kind, double DistanceM);
