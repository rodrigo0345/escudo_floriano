using System.Collections.Concurrent;
using FireTrace.Core.Domain.Common;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record ThreatenedAsset(string AssetType, string Id, string? Name, LatLon? Position, double Probability, Quantiles ArrivalMinute, bool Vulnerable = false, int? Population = null);
