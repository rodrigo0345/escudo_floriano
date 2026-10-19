using System.Text.Json.Serialization;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record LayerInfo(string Id, string Kind, string Url, string? MediaType = null, string? Attribution = null, GeoBounds? Bounds = null);
