using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record WaterPointNear(WaterPointView Point, double DistanceM, double? DriveMinutes = null);
