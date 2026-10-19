using System.Text.Json.Serialization;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record PlaceView(string Id, string Name, string Kind, LatLon Position, int Population, bool PopulationEstimated);
