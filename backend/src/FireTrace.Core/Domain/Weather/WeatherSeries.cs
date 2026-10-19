using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

public sealed record WeatherSeries(string LocationId, IReadOnlyList<WeatherSample> Samples, DateTimeOffset? From = null, DateTimeOffset? To = null, int? StepMinutes = null, List<string>? Sources = null);
