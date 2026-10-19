using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

// Os dados do mapa tal como o contrato os mostra (ids com prefixo, posições {lat, lon}, enumerações em texto). Convertem-se dos tipos de MapData.

public sealed record Feature<TProps>(Geometry Geometry, TProps Properties, string? Id = null) { public string Type => "Feature"; }
