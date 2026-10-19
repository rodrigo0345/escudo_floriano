using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record ProviderOptions(string Source = "open_meteo", LatLon? Point = null);
