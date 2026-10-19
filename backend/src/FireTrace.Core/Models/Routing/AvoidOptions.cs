using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Routing;

public sealed record AvoidOptions(bool ActiveClosures = true, bool PredictedFire = true, string Percentile = "p50", double? BufferM = null);
