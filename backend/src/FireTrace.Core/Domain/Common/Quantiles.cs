using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Common;

/// <summary>Os valores p10/p50/p90 de uma grandeza entre os membros do ensemble.</summary>
public sealed record Quantiles(double? P10, double? P50, double? P90);
