using System.Text.Json.Serialization;
using FireTrace.Core.Domain.Weather;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record LocationView(string Id, string Name, LatLon Center, LatLon WeatherPoint, GeoBounds Bounds, string Timezone, GridInfo Grid, GridInfo RenderGrid,
    NumberRange ElevationM, IReadOnlyList<LayerInfo> Layers, IReadOnlyList<string> DataSources);
