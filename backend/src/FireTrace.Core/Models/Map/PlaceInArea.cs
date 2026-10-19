using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record PlaceInArea(string PlaceId, string Name, int Population);
