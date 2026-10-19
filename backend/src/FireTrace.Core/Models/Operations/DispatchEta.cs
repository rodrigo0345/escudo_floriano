using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Operations;

public sealed record DispatchEta(string ResourceId, double? EtaMinutes);
