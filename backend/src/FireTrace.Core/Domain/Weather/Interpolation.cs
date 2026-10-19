using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record Interpolation(string Default = "linear", string WindDirection = "shortest_arc");
